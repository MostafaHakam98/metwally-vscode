import { ChildProcess, spawn } from "child_process";
import { StringDecoder } from "string_decoder";
import { EventEmitter } from "events";

// =============================================================================
// Types for the pi RPC protocol
// =============================================================================

export interface RpcCommand {
    id?: string;
    type: string;
    [key: string]: unknown;
}

export interface RpcResponse {
    type: "response";
    id?: string;
    command: string;
    success: boolean;
    data?: unknown;
    error?: string;
}

export interface AgentEvent {
    type: string;
    [key: string]: unknown;
}

export interface MessageUpdateEvent extends AgentEvent {
    type: "message_update";
    usage?: UsageInfo;
    assistantMessageEvent: {
        type: string;
        contentIndex: number;
        delta?: string;
        content?: string;
        id?: string;
        toolName?: string;
        toolCall?: { type: string; id: string; name: string; arguments: Record<string, unknown> };
    };
}

export interface ToolExecutionEvent extends AgentEvent {
    type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
    partialResult?: { content: Array<{ type: string; text?: string }> };
    result?: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> };
    isError?: boolean;
}

export interface UsageInfo {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface PiRpcClientOptions {
    piPath: string;
    cwd: string;
    noSession?: boolean;
    sessionDir?: string;
    model?: string;
    provider?: string;
    extraArgs?: string[];
    /** Appended after --provider/--model, from piVscode.extraArgs. */
    userArgs?: string[];
    /** Merged over the inherited environment, from piVscode.env. */
    env?: Record<string, string>;
}

// =============================================================================
// PiRpcClient
// =============================================================================

interface PendingRequest {
    resolve: (response: RpcResponse) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
}

export class PiRpcClient extends EventEmitter {
    private proc: ChildProcess | null = null;
    private decoder = new StringDecoder("utf8");
    private buffer = "";
    private pending = new Map<string, PendingRequest>();
    private reqCounter = 0;
    private started = false;

    constructor(private options: PiRpcClientOptions) {
        super();
    }

    /** Spawn the pi process (idempotent) */
    ensureStarted(): void {
        if (this.proc) return;

        const args = ["--mode", "rpc"];
        if (this.options.noSession) args.push("--no-session");
        if (this.options.sessionDir) args.push("--session-dir", this.options.sessionDir);
        // Extension scripts (-e) come first: they are what registers the
        // provider that --provider then selects.
        if (this.options.extraArgs) args.push(...this.options.extraArgs);
        if (this.options.provider) args.push("--provider", this.options.provider);
        if (this.options.model) args.push("--model", this.options.model);
        if (this.options.userArgs) args.push(...this.options.userArgs);

        this.proc = spawn(this.options.piPath, args, {
            cwd: this.options.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            // The caller builds PATH from the node installs actually present, so
            // nothing here is pinned to one version. User env wins last.
            env: { ...process.env, ...(this.options.env ?? {}) },
        });

        this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
        this.proc.stderr!.on("data", (chunk: Buffer) => {
            this.emit("stderr", chunk.toString());
        });
        this.proc.on("exit", (code, signal) => {
            this.emit("exit", { code, signal });
            this.proc = null;
            this.started = false;
        });
        this.proc.on("error", (err) => {
            this.emit("error", err);
        });

        this.started = true;
        this.emit("started");
    }

    /** Send a command and wait for response */
    send(command: RpcCommand, timeoutMs = 60_000): Promise<RpcResponse> {
        this.ensureStarted();

        return new Promise<RpcResponse>((resolve, reject) => {
            const id = command.id || `req-${++this.reqCounter}`;
            const fullCommand = { ...command, id };

            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`RPC timeout after ${timeoutMs}ms: ${command.type}`));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timer });
            this.write(fullCommand);
        });
    }

    /** Fire-and-forget (no response needed) */
    sendFire(command: RpcCommand): void {
        this.ensureStarted();
        this.write(command);
    }

    /** Kill the process */
    kill(): void {
        if (this.proc) {
            this.proc.kill("SIGTERM");
            // Force kill after 3s
            setTimeout(() => {
                if (this.proc) this.proc.kill("SIGKILL");
            }, 3000);
            this.proc = null;
        }
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error("Process killed"));
        }
        this.pending.clear();
    }

    get isRunning(): boolean {
        return this.proc !== null;
    }

    // --------------------------------------------------------------------------
    // Internals
    // --------------------------------------------------------------------------

    private write(cmd: RpcCommand): void {
        if (!this.proc?.stdin?.writable) {
            throw new Error("Process not running");
        }
        this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    }

    private onStdout(chunk: Buffer): void {
        this.buffer += this.decoder.write(chunk);

        // Strict LF-only framing per the RPC protocol
        while (true) {
            const idx = this.buffer.indexOf("\n");
            if (idx === -1) break;

            let line = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);

            if (!line.trim()) continue;

            let parsed: RpcResponse | AgentEvent;
            try {
                parsed = JSON.parse(line);
            } catch {
                this.emit("parse-error", line);
                continue;
            }

            if (parsed.type === "response") {
                this.handleResponse(parsed as RpcResponse);
            } else {
                this.emit("event", parsed);
            }
        }
    }

    private handleResponse(res: RpcResponse): void {
        const id = res.id;
        const pending = id ? this.pending.get(id) : undefined;
        if (pending && id) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            if (res.success) {
                pending.resolve(res);
            } else {
                pending.reject(new Error(res.error || `Command ${res.command} failed`));
            }
        } else {
            // Unsolicited response — emit it
            this.emit("event", res);
        }
    }
}
