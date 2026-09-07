import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { spawnSync } from "child_process";
import { PiRpcClient, UsageInfo } from "./rpc-client";
import {
    CommandKind, CommandScope, commandDir, commandFile, commandInvocation,
    estimateTokens, expandPath as expandPathIn, filePathFromArgs as filePathFromArgsIn,
    humanBytes, isPiCommand, lineDelta, normalizePiCommand, PiCommandInfo,
    promptScaffold, RawPiCommand, relativeTime, skillScaffold,
    slugify, textOf, titleFromPrompt, truncateForContext, validateCommandName,
} from "./lib";
import { renderHtml } from "./webview-html";

// =============================================================================
// Configuration
// =============================================================================

const CFG = "piVscode";

interface ModelChoice {
    id: string;
    label: string;
    provider: string;
    contextWindow: number;
}

function cfg<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(CFG).get<T>(key, fallback);
}

function modelList(): ModelChoice[] {
    const raw = cfg<ModelChoice[]>("models", []);
    if (raw.length) return raw;
    return [{
        id: cfg("model", "qwen3.8-27b"),
        label: cfg("modelLabel", "Qwen3.8-27B"),
        provider: cfg("provider", "qwen38-a100"),
        contextWindow: cfg("contextWindow", 229_000),
    }];
}

function activeModel(): ModelChoice {
    const id = cfg("model", "qwen3.8-27b");
    return modelList().find((m) => m.id === id) ?? modelList()[0];
}

/** Expand ~ and ${workspaceFolder} so path settings behave like the rest of VS Code. */
function expandPath(raw: string): string {
    return expandPathIn(raw, os.homedir(), vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "");
}

/** Working directory for the agent: the setting if given, else the first folder. */
function workingDir(): string {
    const configured = expandPath(cfg("workingDirectory", ""));
    if (configured) return configured;
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

// =============================================================================
// Logging — a real output channel beats appending to a temp file.
// =============================================================================

let out: vscode.LogOutputChannel;
const log = (msg: string) => out?.appendLine(msg);

// =============================================================================
// pi binary resolution
// =============================================================================

/** Every node bin directory we can see, newest nvm install last. */
function nodeBinDirs(): string[] {
    const dirs: string[] = [];
    const nvmDir = path.join(os.homedir(), ".nvm", "versions", "node");
    try {
        const versions = fs.readdirSync(nvmDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
        for (const v of versions) dirs.push(path.join(nvmDir, v, "bin"));
    } catch { /* nvm not installed */ }
    dirs.push("/usr/local/bin", path.join(os.homedir(), ".local", "bin"));
    return dirs.filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
}

interface PiLocation { path: string; found: boolean }

/**
 * Cached because resolution can shell out to `which`, and sendInit runs on every
 * view registration. Invalidated whenever piPath changes or the agent restarts.
 */
let piCache: PiLocation | null = null;

function resolvePi(): PiLocation {
    if (!piCache) piCache = probePi();
    return piCache;
}

function invalidatePiCache(): void {
    piCache = null;
}

/**
 * Locate the pi binary and report whether we actually found it, so the chat
 * view can show a real "not installed" state instead of failing on first send.
 */
function probePi(): PiLocation {
    const configured = expandPath(cfg("piPath", "pi")) || "pi";

    if (path.isAbsolute(configured)) {
        return { path: configured, found: fs.existsSync(configured) };
    }

    for (const dir of nodeBinDirs()) {
        const candidate = path.join(dir, configured);
        try { if (fs.existsSync(candidate)) return { path: candidate, found: true }; } catch { /* ignore */ }
    }

    // Bare name that is not in a known install dir: it may still be on PATH.
    try {
        const probe = spawnSync(process.platform === "win32" ? "where" : "which", [configured], {
            encoding: "utf8",
            timeout: 3000,
        });
        if (probe.status === 0 && probe.stdout.trim()) {
            return { path: probe.stdout.split(/\r?\n/)[0].trim(), found: true };
        }
    } catch { /* which unavailable */ }

    return { path: configured, found: false };
}

/**
 * Environment for the pi process. The discovered node bin directories are
 * prepended to PATH so nvm installs resolve without pinning a version, then the
 * user's piVscode.env wins.
 */
function piEnv(): Record<string, string> {
    const dirs = nodeBinDirs().join(path.delimiter);
    const base: Record<string, string> = {
        PATH: `${dirs}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    const user = cfg<Record<string, string>>("env", {});
    for (const [k, v] of Object.entries(user)) base[k] = String(v);
    return base;
}

// =============================================================================
// Prompt actions — the built-ins and piVscode.customActions share one code path
// =============================================================================

interface ActionDef {
    id: string;
    title: string;
    prompt: string;
    autoSend?: boolean;
    includeSelection?: boolean;
    includeDiagnostics?: boolean;
}

const BUILTIN_ACTIONS: ActionDef[] = [
    {
        id: "explain",
        title: "Explain Selection",
        prompt: "Explain this code — what it does, why it is written this way, and anything risky about it.",
        autoSend: true,
        includeSelection: true,
    },
    {
        id: "fix",
        title: "Fix Problems in Selection",
        prompt: "Fix the problems in this code.",
        autoSend: true,
        includeSelection: true,
        includeDiagnostics: true,
    },
    {
        id: "test",
        title: "Write Tests for Selection",
        prompt: "Write focused tests for this code, then run them.",
        autoSend: true,
        includeSelection: true,
    },
    {
        id: "review",
        title: "Review Uncommitted Changes",
        prompt: "Review my uncommitted changes for correctness, maintainability and CI impact. Tag each finding by severity.",
        autoSend: true,
        includeSelection: false,
    },
];

/** Built-ins plus user actions; a user entry reusing an id replaces the built-in. */
function allActions(): ActionDef[] {
    const merged = new Map<string, ActionDef>(BUILTIN_ACTIONS.map((a) => [a.id, a]));
    for (const raw of cfg<ActionDef[]>("customActions", [])) {
        if (!raw?.id || !raw.title || !raw.prompt) {
            log(`ignoring custom action without id/title/prompt: ${JSON.stringify(raw)}`);
            continue;
        }
        merged.set(raw.id, { ...merged.get(raw.id), ...raw });
    }
    return [...merged.values()];
}

/** Problems reported for the selection, or for the whole file when nothing is selected. */
function diagnosticsFor(editor: vscode.TextEditor): string {
    const items = vscode.languages.getDiagnostics(editor.document.uri)
        .filter((d) => (editor.selection.isEmpty ? true : !!d.range.intersection(editor.selection)))
        .slice(0, 20)
        .map((d) => `- [${vscode.DiagnosticSeverity[d.severity]}] line ${d.range.start.line + 1}: ${d.message}`);
    return items.join("\n");
}

// =============================================================================
// Edit review — snapshot files before a tool touches them, diff them after
// =============================================================================

const BEFORE_SCHEME = "metwally-before";

/** Pre-edit file contents, keyed by the virtual URI path that renders them. */
const beforeStore = new Map<string, string>();

class BeforeContentProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
        return beforeStore.get(uri.path) ?? "";
    }
}

function filePathFromArgs(args?: Record<string, unknown>): string | null {
    return filePathFromArgsIn(args, workingDir());
}

function readOrEmpty(file: string): string {
    try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

// =============================================================================
// ChatSession — one pi process, one conversation, one view
// =============================================================================

interface Attachment {
    kind: "image" | "file" | "ref";
    name: string;
    data?: string;
    mimeType?: string;
    content?: string;
    path?: string;
}

class ChatSession {
    private client: PiRpcClient | null = null;
    private views = new Set<vscode.Webview>();
    private busy = false;
    private usage: UsageInfo | null = null;
    /** Cleared on every new session so auto-context is sent exactly once. */
    private sentAutoContext = false;
    /** False until the first prompt names the tab. */
    private titled = false;
    /** Files re-read and re-sent on every turn, keyed by absolute path. */
    private pins = new Map<string, string>();
    /** Pre-edit snapshots for this turn, keyed by absolute path. */
    private snapshots = new Map<string, string>();
    /** Files a tool actually changed, keyed by absolute path. */
    private edits = new Map<string, { added: number; removed: number }>();
    /** Effort already pushed to pi, so we only send set_thinking_level on change. */
    private thinkingLevel = "";
    /** Reported by get_session_stats; the on-disk session this process writes. */
    private sessionFile = "";

    /** Brings this session's view to the front; installed by the owning view. */
    reveal: () => void = () => { /* replaced when a view takes ownership */ };
    /** Lets the owning view follow the auto-generated title. */
    onTitle: ((title: string) => void) | null = null;

    constructor(
        readonly id: string,
        public title: string,
        private readonly onChanged: (s: ChatSession) => void,
    ) {}

    get isBusy(): boolean { return this.busy; }
    get cost(): number | undefined { return this.usage?.cost?.total; }

    // --- view registry -------------------------------------------------------

    register(webview: vscode.Webview, markActive: () => void): vscode.Disposable {
        this.views.add(webview);
        const sub = webview.onDidReceiveMessage((m) => {
            // Any interaction makes this the session editor commands target.
            markActive();
            void this.onMessage(m, webview);
        });
        this.sendInit(webview);
        this.sendPins();
        return new vscode.Disposable(() => {
            sub.dispose();
            this.views.delete(webview);
        });
    }

    private broadcast(msg: Record<string, unknown>): void {
        for (const v of this.views) void v.postMessage(msg);
    }

    private sendInit(webview: vscode.Webview): void {
        const m = activeModel();
        const folder = vscode.workspace.workspaceFolders?.[0];
        const pi = resolvePi();
        void webview.postMessage({
            type: "init",
            model: m.id,
            modelLabel: m.label,
            provider: m.provider,
            contextWindow: m.contextWindow,
            cwd: workingDir(),
            workspace: folder?.name ?? "",
            showThinking: cfg("showThinking", "collapsed"),
            defaultEffort: cfg("defaultEffort", "high"),
            piMissing: !pi.found,
            piPath: pi.path,
        });
        if (this.usage) void webview.postMessage({ type: "usage", usage: this.usage });
    }

    /** Push the view-affecting settings without restarting the agent. */
    settingsChanged(): void {
        this.broadcast({
            type: "settings",
            showThinking: cfg("showThinking", "collapsed"),
            defaultEffort: cfg("defaultEffort", "high"),
        });
    }

    /** Name the tab after the first prompt, the way an editor names a file. */
    private nameFromPrompt(text: string): void {
        if (this.titled) return;
        const line = titleFromPrompt(text);
        if (!line) return;
        this.titled = true;
        this.title = line;
        this.onTitle?.(this.title);
        this.onChanged(this);
    }

    // --- pi process ----------------------------------------------------------

    private ensureClient(): PiRpcClient {
        if (this.client) return this.client;

        const workDir = workingDir();
        const pi = resolvePi();
        const piPath = pi.path;
        const model = activeModel();
        if (!pi.found) log(`warning: pi binary not found at "${piPath}"`);

        // The setting declares "" as its default, so an empty value means
        // "unset" and we fall back to the checked-in vLLM provider script.
        const extraArgs: string[] = [];
        // In --mode rpc pi never prompts for trust, so without --approve every
        // project .pi/ skill, prompt template and setting is silently ignored.
        if (cfg("trustProject", false)) {
            extraArgs.push("--approve");
            log("project trust: --approve (project .pi/ resources are loaded)");
        }
        const configured = cfg("providerScript", "").trim();
        const scriptPath = configured || path.join(os.homedir(), "pi-vscode", "pi-config", "extensions", "vllm-stream.ts");
        if (fs.existsSync(scriptPath)) {
            extraArgs.push("-e", scriptPath);
            log(`provider script: ${scriptPath}`);
        } else if (configured) {
            log(`provider script not found, ignoring: ${scriptPath}`);
        }

        log(`spawn: ${piPath} (cwd=${workDir}, model=${model.id}, provider=${model.provider})`);

        const sessionDir = expandPath(cfg("sessionDir", ""));
        if (sessionDir) log(`session dir: ${sessionDir}`);

        const client = new PiRpcClient({
            piPath,
            cwd: workDir,
            noSession: cfg("noSession", false),
            sessionDir: sessionDir || undefined,
            provider: model.provider,
            model: model.id,
            extraArgs,
            userArgs: cfg<string[]>("extraArgs", []),
            env: piEnv(),
        });

        client.on("event", (ev: Record<string, unknown>) => this.onAgentEvent(ev as unknown as AnyEvent));
        client.on("stderr", (txt: string) => {
            const t = txt.trim();
            if (t) log(`stderr: ${t}`);
        });
        client.on("error", (err: Error) => {
            log(`spawn error: ${err.message}`);
            this.setBusy(false);
            this.broadcast({
                type: "error",
                title: "Cannot start pi",
                text: `${err.message}. Checked "${piPath}" — set "${CFG}.piPath" to the absolute path of the pi binary.`,
            });
        });
        client.on("exit", (info: { code: number | null; signal: string | null }) => {
            log(`exit: code=${info.code} signal=${info.signal}`);
            this.client = null;
            this.setBusy(false);
            if (info.code !== 0 && info.code !== null) {
                this.broadcast({
                    type: "error",
                    title: "Agent stopped",
                    text: `pi exited with code ${info.code}. See the "Metwally" output channel for details.`,
                });
            }
        });

        this.client = client;
        void this.publishThinkingLevels();
        void this.publishCommands();
        return client;
    }

    private onAgentEvent(ev: AnyEvent): void {
        switch (ev.type) {
            case "agent_start":
                this.setBusy(true);
                this.snapshots.clear();
                break;

            case "agent_settled":
                this.setBusy(false);
                this.broadcast({ type: "message-end" });
                void this.refreshStats();
                break;

            case "message_update": {
                if (ev.usage) this.setUsage(ev.usage);
                const d = ev.assistantMessageEvent;
                if (!d) break;
                switch (d.type) {
                    case "text_delta":
                        this.broadcast({ type: "text-delta", text: d.delta ?? "" });
                        break;
                    case "thinking_start":
                        this.broadcast({ type: "thinking-start" });
                        break;
                    case "thinking_delta":
                        this.broadcast({ type: "thinking-delta", text: d.delta ?? "" });
                        break;
                    case "thinking_end":
                        this.broadcast({ type: "thinking-end" });
                        break;
                }
                break;
            }

            case "tool_execution_start": {
                // Snapshot before the tool runs — this is the only moment the
                // pre-edit content is still on disk.
                if (cfg("reviewEdits", true)) {
                    const file = filePathFromArgs(ev.args);
                    if (file && !this.snapshots.has(file)) this.snapshots.set(file, readOrEmpty(file));
                }
                this.broadcast({ type: "tool-start", toolName: ev.toolName, args: ev.args });
                break;
            }

            case "tool_execution_update":
                this.broadcast({ type: "tool-update", output: textOf(ev.partialResult) });
                break;

            case "tool_execution_end": {
                this.broadcast({ type: "tool-end", output: textOf(ev.result), isError: !!ev.isError });
                const file = filePathFromArgs(ev.args);
                if (file && this.snapshots.has(file)) {
                    const before = this.snapshots.get(file) as string;
                    const after = readOrEmpty(file);
                    if (before !== after) {
                        this.edits.set(file, lineDelta(before, after));
                        this.sendEdits();
                    }
                }
                break;
            }

            case "compaction_start":
                this.broadcast({ type: "info", title: "Compacting", text: "Summarising the conversation to free context." });
                break;

            case "error":
                this.broadcast({ type: "error", text: String(ev.message ?? "Unknown agent error") });
                break;
        }
    }

    private setBusy(on: boolean): void {
        this.busy = on;
        this.broadcast({ type: "streaming", active: on });
        this.onChanged(this);
    }

    private setUsage(u: UsageInfo): void {
        this.usage = u;
        this.broadcast({ type: "usage", usage: u });
        this.onChanged(this);
    }

    // --- webview -> extension ------------------------------------------------

    private async onMessage(msg: AnyMessage, webview: vscode.Webview): Promise<void> {
        switch (msg.type) {
            case "ready":
                this.sendInit(webview);
                break;

            case "prompt":
                await this.submit(String(msg.text ?? ""), (msg.attachments as Attachment[]) ?? [], String(msg.effort ?? "off"));
                break;

            case "abort":
                this.client?.sendFire({ type: "abort" });
                this.setBusy(false);
                break;

            case "new-session":
                await this.newSession();
                break;

            case "list-sessions":
                this.broadcast({ type: "sessions", sessions: listSessions() });
                break;

            case "switch-session":
                try {
                    await this.ensureClient().send(
                        { type: "switch_session", sessionPath: msg.path } as never,
                        cfg("startupTimeoutMs", 30_000),
                    );
                    this.sentAutoContext = false;
                    this.broadcast({ type: "clear" });
                    this.sendPins();
                } catch (err) {
                    this.broadcast({ type: "error", text: (err as Error).message });
                }
                break;

            case "attach-file":
                await this.pickAttachment();
                break;

            case "search-files":
                this.broadcast({ type: "files", files: await searchFiles(String(msg.query ?? "")) });
                break;

            case "copy":
                await vscode.env.clipboard.writeText(String(msg.text ?? ""));
                break;

            case "insert-code":
                await insertAtCursor(String(msg.code ?? ""));
                break;

            case "new-file":
                await openScratch(String(msg.code ?? ""), String(msg.lang ?? ""));
                break;

            case "open-file":
                await openWorkspaceFile(String(msg.path ?? ""));
                break;

            case "open-external":
                await vscode.env.openExternal(vscode.Uri.parse(String(msg.url ?? "")));
                break;

            case "export":
                await openScratch(String(msg.markdown ?? ""), "markdown");
                break;

            case "open-settings":
                await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:local.pi-vscode`);
                break;

            case "pick-model":
                await this.pickModel();
                break;

            case "open-logs":
                out.show();
                break;

            case "browse-commands":
                await vscode.commands.executeCommand(`${CFG}.browseCommands`);
                break;

            case "new-skill":
                await vscode.commands.executeCommand(`${CFG}.newSkill`);
                break;

            case "new-prompt":
                await vscode.commands.executeCommand(`${CFG}.newPromptTemplate`);
                break;

            case "list-commands":
                await this.publishCommands();
                break;

            case "open-diff":
                await this.openDiff(String(msg.path ?? ""));
                break;

            case "revert-edit":
                await this.revertEdit(String(msg.path ?? ""));
                break;

            case "dismiss-edits":
                this.clearEdits();
                break;

            case "compact":
                // pi compacts natively; the old /compact just asked the model
                // nicely and hoped, which did not actually free context.
                try {
                    const res = await this.ensureClient().send({ type: "compact" } as never, cfg("requestTimeoutMs", 600_000));
                    const d = (res.data ?? {}) as { tokensBefore?: number; estimatedTokensAfter?: number };
                    const saved = (d.tokensBefore ?? 0) - (d.estimatedTokensAfter ?? 0);
                    this.broadcast({
                        type: "info",
                        title: "Compacted",
                        text: saved > 0
                            ? `Freed roughly ${saved.toLocaleString()} tokens.`
                            : "Conversation compacted.",
                    });
                    void this.refreshStats();
                } catch (err) {
                    this.broadcast({ type: "error", title: "Compaction failed", text: (err as Error).message });
                }
                break;

            case "steer":
                try {
                    await this.ensureClient().send(
                        { type: "steer", message: String(msg.text ?? "") } as never,
                        cfg("startupTimeoutMs", 30_000),
                    );
                    this.broadcast({ type: "steered", text: String(msg.text ?? "") });
                } catch (err) {
                    this.broadcast({ type: "error", title: "Cannot steer", text: (err as Error).message });
                }
                break;

            case "pin":
                this.pin(String(msg.path ?? ""), String(msg.name ?? ""));
                break;

            case "unpin":
                this.pins.delete(String(msg.path ?? ""));
                this.sendPins();
                break;

            case "context-info":
                this.broadcast({ type: "context-info", info: this.contextManifest() });
                break;

            case "quick-add":
                await this.quickAdd(String(msg.kind ?? ""));
                break;

            case "run-action":
                await vscode.commands.executeCommand(`${CFG}.runAction`);
                break;

            case "restart":
                this.restart();
                break;

            case "resolve-uri":
                this.attach(vscode.Uri.parse(String(msg.uri ?? "")));
                break;
        }
    }

    // --- actions -------------------------------------------------------------

    async submit(text: string, attachments: Attachment[], effort: string): Promise<void> {
        if (!text.trim() && !attachments.length) return;
        this.nameFromPrompt(text);

        // pi expands /template and /skill:name itself, but only when the slash
        // is the first character. Prepending a preamble or attached context
        // would silently turn the command into literal prompt text.
        if (isPiCommand(text) && !attachments.length) {
            this.broadcast({ type: "user-message", text, attachments: [] });
            this.setBusy(true);
            try {
                await this.applyThinking(effort);
                await this.ensureClient().send(
                    { type: "prompt", message: text.trim() } as never,
                    cfg("requestTimeoutMs", 600_000),
                );
            } catch (err) {
                this.broadcast({ type: "error", text: (err as Error).message });
                this.setBusy(false);
            }
            return;
        }

        this.broadcast({ type: "user-message", text, attachments: attachments.map((a) => ({ kind: a.kind, name: a.name })) });
        this.setBusy(true);

        const images: Array<{ data: string; mimeType: string }> = [];
        const context: string[] = [];

        const limit = Math.max(1000, cfg("maxAttachmentBytes", 120_000));

        // Project conventions go in first, once per session, so they sit above
        // the per-turn attachments rather than being re-sent on every prompt.
        if (!this.sentAutoContext) {
            this.sentAutoContext = true;
            for (const file of autoContextFiles(limit)) context.push(file);
        }

        for (const a of attachments) {
            if (a.kind === "image" && a.data) {
                images.push({ data: a.data, mimeType: a.mimeType ?? "image/png" });
            } else if (a.kind === "ref" && a.path) {
                context.push(readForContext(a.path, a.name, limit));
            } else if (a.content) {
                context.push(`--- ${a.name} ---\n${a.content.slice(0, limit)}`);
            }
        }

        // Pins are re-read every turn, so edits since the last prompt land.
        for (const file of globalPins()) {
            context.push(readForContext(file, vscode.workspace.asRelativePath(vscode.Uri.file(file)), limit));
        }
        for (const [file, name] of this.pins) context.push(readForContext(file, name, limit));

        if (cfg("attachActiveFile", false)) {
            const active = selectionContext();
            if (active) context.push(`--- active editor ---\n${active}`);
        }

        let full = text;
        if (context.length) full = `${context.join("\n\n")}\n\n${text}`;
        const preamble = cfg("promptPreamble", "").trim();
        if (preamble) full = `${preamble}\n\n${full}`;

        const cmd: Record<string, unknown> = { type: "prompt", message: full };
        if (images.length) cmd.images = images;

        try {
            // Reasoning level is a real pi setting, not prompt text.
            await this.applyThinking(effort);
            await this.ensureClient().send(cmd as never, cfg("requestTimeoutMs", 600_000));
        } catch (err) {
            this.broadcast({ type: "error", text: (err as Error).message });
            this.setBusy(false);
        }
    }

    async newSession(): Promise<void> {
        if (cfg("confirmNewSession", true) && this.usage) {
            const yes = await vscode.window.showWarningMessage(
                "Start a new Metwally session? The current transcript is discarded.",
                { modal: true },
                "New Session",
            );
            if (yes !== "New Session") return;
        }
        try {
            await this.ensureClient().send({ type: "new_session" } as never, cfg("startupTimeoutMs", 30_000));
        } catch (err) {
            log(`new_session failed: ${(err as Error).message}`);
        }
        this.sentAutoContext = false;
        this.usage = null;
        this.titled = false;
        this.onChanged(this);
        this.broadcast({ type: "clear" });
        this.sendPins();
    }

    abort(): void {
        this.client?.sendFire({ type: "abort" });
        this.setBusy(false);
    }

    /** Drop the pi process so the next prompt respawns it with fresh settings. */
    restart(): void {
        this.client?.kill();
        this.client = null;
        this.sentAutoContext = false;
        this.thinkingLevel = "";
        this.setBusy(false);
        for (const v of this.views) this.sendInit(v);
        this.broadcast({ type: "toast", text: "Agent restarted with the new settings" });
    }

    /** Push text into this session's composer, bringing its view forward. */
    fill(text: string, autoSend: boolean): void {
        this.reveal();
        if (autoSend) this.nameFromPrompt(text);
        this.broadcast({ type: "set-input", text, send: autoSend });
    }

    // --- pi state ------------------------------------------------------------

    /**
     * Ask pi for the real context usage. The ring used to divide cumulative
     * session tokens by the window, which double-counts every cached turn and
     * only ever climbs; contextUsage is what pi itself compacts against.
     */
    private async refreshStats(): Promise<void> {
        if (!this.client) return;
        try {
            const res = await this.client.send({ type: "get_session_stats" } as never, 15_000);
            const d = (res.data ?? {}) as {
                sessionFile?: string;
                contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
            };
            if (d.sessionFile) this.sessionFile = d.sessionFile;
            if (d.contextUsage && d.contextUsage.percent !== null) {
                this.broadcast({ type: "context-usage", usage: d.contextUsage });
            }
        } catch (err) {
            log(`get_session_stats failed: ${(err as Error).message}`);
        }
    }

    /** Push the reasoning level through pi's own API rather than prompt text. */
    private async applyThinking(level: string): Promise<void> {
        if (!level || level === this.thinkingLevel) return;
        try {
            await this.ensureClient().send({ type: "set_thinking_level", level } as never, 15_000);
            this.thinkingLevel = level;
        } catch (err) {
            // Model without reasoning support, or an unknown level: log and move
            // on rather than blocking the prompt.
            log(`set_thinking_level(${level}) failed: ${(err as Error).message}`);
        }
    }

    /** Swap models in place. Falls back to a respawn when pi refuses. */
    async applyModel(m: ModelChoice): Promise<void> {
        if (!this.client) return;
        try {
            await this.client.send(
                { type: "set_model", provider: m.provider, modelId: m.id } as never,
                cfg("startupTimeoutMs", 30_000),
            );
            this.thinkingLevel = "";
            this.broadcast({ type: "model", model: m.id, modelLabel: m.label, contextWindow: m.contextWindow });
        } catch (err) {
            log(`set_model failed, restarting instead: ${(err as Error).message}`);
            this.restart();
        }
    }

    /**
     * pi's own command catalogue: extension commands, prompt templates and
     * skills. Sent to the view so `/` lists them alongside the UI commands.
     */
    async publishCommands(): Promise<void> {
        const commands = await this.fetchCommands();
        if (commands) this.broadcast({ type: "commands", commands });
    }

    /** Null when this session has no live process to ask. */
    async fetchCommands(): Promise<PiCommandInfo[] | null> {
        if (!this.client) return null;
        try {
            const res = await this.client.send({ type: "get_commands" } as never, 15_000);
            const raw = ((res.data ?? {}) as { commands?: RawPiCommand[] }).commands ?? [];
            return raw.filter((c) => c?.name).map(normalizePiCommand);
        } catch (err) {
            log(`get_commands failed: ${(err as Error).message}`);
            return null;
        }
    }

    /** Which thinking levels this model supports, so the UI can grey out the rest. */
    private async publishThinkingLevels(): Promise<void> {
        if (!this.client) return;
        try {
            const res = await this.client.send({ type: "get_available_thinking_levels" } as never, 15_000);
            const levels = ((res.data ?? {}) as { levels?: string[] }).levels;
            if (levels?.length) this.broadcast({ type: "thinking-levels", levels });
        } catch (err) {
            log(`get_available_thinking_levels failed: ${(err as Error).message}`);
        }
    }

    // --- edit review ---------------------------------------------------------

    private sendEdits(): void {
        this.broadcast({
            type: "edits",
            edits: [...this.edits.entries()].map(([file, d]) => ({
                path: file,
                name: vscode.workspace.asRelativePath(vscode.Uri.file(file)),
                added: d.added,
                removed: d.removed,
            })),
        });
    }

    /** Side-by-side against the pre-edit snapshot, using a virtual document. */
    private async openDiff(file: string): Promise<void> {
        const before = this.snapshots.get(file);
        if (before === undefined) return;
        const key = `/${this.id}${file}`;
        beforeStore.set(key, before);
        const left = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: key });
        const rel = vscode.workspace.asRelativePath(vscode.Uri.file(file));
        await vscode.commands.executeCommand("vscode.diff", left, vscode.Uri.file(file),
            `${rel} — before ↔ after Metwally`, { preview: true });
    }

    private async revertEdit(file: string): Promise<void> {
        const before = this.snapshots.get(file);
        if (before === undefined) return;
        const rel = vscode.workspace.asRelativePath(vscode.Uri.file(file));
        const yes = await vscode.window.showWarningMessage(
            `Restore ${rel} to its state before Metwally edited it?`, { modal: true }, "Revert",
        );
        if (yes !== "Revert") return;
        try {
            fs.writeFileSync(file, before, "utf8");
            this.edits.delete(file);
            this.sendEdits();
            this.broadcast({ type: "toast", text: `Reverted ${rel}` });
        } catch (err) {
            this.broadcast({ type: "toast", kind: "err", text: `Cannot revert ${rel}` });
            log(`revert failed: ${(err as Error).message}`);
        }
    }

    /** Called once a turn settles: the next turn gets fresh snapshots. */
    private clearEdits(): void {
        this.snapshots.clear();
        this.edits.clear();
        this.sendEdits();
    }

    // --- context ------------------------------------------------------------

    pin(file: string, label?: string): void {
        if (!file) return;
        try { if (!fs.statSync(file).isFile()) return; } catch { return; }
        this.pins.set(file, label || vscode.workspace.asRelativePath(vscode.Uri.file(file)));
        this.sendPins();
    }

    private sendPins(): void {
        this.broadcast({
            type: "pins",
            pins: [...this.pins.entries()].map(([path, name]) => ({ path, name })),
        });
    }

    /** Inline text (a diff, a problem list) shown as an attachment chip. */
    private attachInline(name: string, content: string): void {
        this.reveal();
        this.broadcast({ type: "attachment", attachment: { kind: "file", name, content } });
    }

    /**
     * Everything that will be prepended to the next prompt, with rough token
     * estimates. Auto-context is listed too — it used to be invisible.
     */
    private contextManifest(): Record<string, unknown> {
        const items: Array<Record<string, unknown>> = [];
        const add = (kind: string, name: string, file: string, note?: string) => {
            let bytes = 0;
            try { bytes = fs.statSync(file).size; } catch { return; }
            items.push({ kind, name, bytes, tokens: estimateTokens(bytes), note });
        };

        for (const name of cfg<string[]>("autoContextFiles", [])) {
            if (!name?.trim()) continue;
            const full = path.isAbsolute(name) ? name : path.join(workingDir(), name);
            add("auto", name, full, this.sentAutoContext ? "already sent" : "sent with next prompt");
        }
        for (const file of globalPins()) {
            add("pin", vscode.workspace.asRelativePath(vscode.Uri.file(file)), file, "from settings");
        }
        for (const [file, name] of this.pins) add("pin", name, file, "this session");

        if (cfg("attachActiveFile", false)) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const text = editor.selection.isEmpty
                    ? editor.document.getText()
                    : editor.document.getText(editor.selection);
                items.push({
                    kind: "active",
                    name: vscode.workspace.asRelativePath(editor.document.uri),
                    bytes: text.length,
                    tokens: estimateTokens(text.length),
                    note: editor.selection.isEmpty ? "whole file" : "selection",
                });
            }
        }

        return {
            items,
            totalTokens: items.reduce((n, i) => n + (i.tokens as number), 0),
            window: activeModel().contextWindow,
            limit: Math.max(1000, cfg("maxAttachmentBytes", 120_000)),
        };
    }

    /** Workspace context the agent cannot cheaply gather itself. */
    private async quickAdd(kind: string): Promise<void> {
        switch (kind) {
            case "open-editors": {
                const uris = vscode.window.tabGroups.all
                    .flatMap((g) => g.tabs)
                    .map((t) => (t.input instanceof vscode.TabInputText ? t.input.uri : null))
                    .filter((u): u is vscode.Uri => !!u);
                const seen = new Set<string>();
                let n = 0;
                for (const uri of uris) {
                    if (seen.has(uri.fsPath)) continue;
                    seen.add(uri.fsPath);
                    this.attach(uri);
                    n++;
                }
                if (!n) this.broadcast({ type: "toast", kind: "err", text: "No open text editors" });
                break;
            }

            case "git-diff": {
                const diff = gitDiff();
                if (!diff) {
                    this.broadcast({ type: "toast", kind: "err", text: "No uncommitted changes" });
                    break;
                }
                this.attachInline("git diff HEAD", diff);
                break;
            }

            case "problems": {
                const text = workspaceProblems();
                if (!text) {
                    this.broadcast({ type: "toast", kind: "err", text: "No problems reported" });
                    break;
                }
                this.attachInline("problems", text);
                break;
            }

            case "active-file": {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    this.broadcast({ type: "toast", kind: "err", text: "No active editor" });
                    break;
                }
                this.attach(editor.document.uri);
                break;
            }

            case "selection": {
                const ctx = selectionContext();
                if (!ctx) {
                    this.broadcast({ type: "toast", kind: "err", text: "No active editor" });
                    break;
                }
                this.attachInline("selection", ctx);
                break;
            }

            case "terminal": {
                const text = await terminalSelection();
                if (!text) {
                    this.broadcast({ type: "toast", kind: "err", text: "Select terminal output first" });
                    break;
                }
                this.attachInline("terminal output", text);
                break;
            }
        }
    }

    /** Attach one file to the composer. Images are inlined, everything else is a ref. */
    attach(uri: vscode.Uri): void {
        this.reveal();
        const ext = path.extname(uri.fsPath).toLowerCase();
        const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext);
        try {
            if (!fs.statSync(uri.fsPath).isFile()) return;
            if (!isImage) {
                this.broadcast({
                    type: "attachment",
                    attachment: { kind: "ref", name: vscode.workspace.asRelativePath(uri), path: uri.fsPath },
                });
                return;
            }
            const mime = ext === ".png" ? "image/png"
                : ext === ".gif" ? "image/gif"
                : ext === ".webp" ? "image/webp"
                : ext === ".bmp" ? "image/bmp"
                : "image/jpeg";
            this.broadcast({
                type: "attachment",
                attachment: {
                    kind: "image",
                    name: path.basename(uri.fsPath),
                    data: fs.readFileSync(uri.fsPath).toString("base64"),
                    mimeType: mime,
                },
            });
        } catch (err) {
            this.broadcast({ type: "toast", kind: "err", text: `Cannot read ${path.basename(uri.fsPath)}` });
            log(`attach failed: ${(err as Error).message}`);
        }
    }

    private async pickAttachment(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: "Attach",
            defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        for (const uri of picked ?? []) this.attach(uri);
    }

    private async pickModel(): Promise<void> {
        const models = modelList();
        const current = activeModel();
        const pick = await vscode.window.showQuickPick(
            models.map((m) => ({
                label: m.id === current.id ? `$(check) ${m.label}` : m.label,
                description: m.id,
                detail: `${m.provider} · ${Math.round(m.contextWindow / 1000)}K context`,
                model: m,
            })),
            { title: "Metwally — select model", placeHolder: "Applied to every open session" },
        );
        if (!pick) return;

        await vscode.workspace.getConfiguration(CFG).update("model", pick.model.id, vscode.ConfigurationTarget.Global);
        this.broadcast({ type: "toast", text: `Switched to ${pick.model.label}` });
        this.onChanged(this);
    }

    dispose(): void {
        this.client?.kill();
        this.client = null;
        this.views.clear();
    }
}

// =============================================================================
// Small helpers
// =============================================================================

interface AnyEvent {
    type: string;
    usage?: UsageInfo;
    toolName?: string;
    args?: Record<string, unknown>;
    isError?: boolean;
    message?: unknown;
    partialResult?: { content?: Array<{ type: string; text?: string }> };
    result?: { content?: Array<{ type: string; text?: string }> };
    assistantMessageEvent?: { type: string; delta?: string };
}

type AnyMessage = Record<string, unknown> & { type: string };

interface SessionRow { path: string; name: string; when: string; size: string; }

/** Read a file for prompt context, truncating loudly rather than silently. */
function readForContext(file: string, name: string, limit: number): string {
    try {
        return `--- ${name} ---\n${truncateForContext(fs.readFileSync(file, "utf8"), limit)}`;
    } catch (err) {
        return `--- ${name} (unreadable: ${(err as Error).message}) ---`;
    }
}

/** Convention files from piVscode.autoContextFiles that exist in the working dir. */
function autoContextFiles(limit: number): string[] {
    const dir = workingDir();
    const out: string[] = [];
    for (const name of cfg<string[]>("autoContextFiles", [])) {
        if (!name?.trim()) continue;
        const full = path.isAbsolute(name) ? name : path.join(dir, name);
        try { if (!fs.statSync(full).isFile()) continue; } catch { continue; }
        out.push(readForContext(full, name, limit));
        log(`auto-context: ${name}`);
    }
    return out;
}

/** Files from piVscode.pinnedContext that exist, as absolute paths. */
function globalPins(): string[] {
    const dir = workingDir();
    const out: string[] = [];
    for (const name of cfg<string[]>("pinnedContext", [])) {
        if (!name?.trim()) continue;
        const full = path.isAbsolute(name) ? name : path.join(dir, name);
        try { if (fs.statSync(full).isFile()) out.push(full); } catch { /* gone */ }
    }
    return out;
}

/** Uncommitted changes, staged included. Empty string when there are none. */
function gitDiff(): string {
    const opts = { cwd: workingDir(), encoding: "utf8" as const, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 };
    for (const args of [["diff", "HEAD"], ["diff"]]) {
        try {
            const r = spawnSync("git", args, opts);
            if (r.status === 0 && r.stdout.trim()) return r.stdout;
        } catch { /* git missing */ }
    }
    return "";
}

/** Every diagnostic in the workspace, most severe first. */
function workspaceProblems(): string {
    const rows: string[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        const rel = vscode.workspace.asRelativePath(uri);
        for (const d of diags) {
            rows.push(`${vscode.DiagnosticSeverity[d.severity]} ${rel}:${d.range.start.line + 1} — ${d.message}`);
        }
    }
    rows.sort();
    return rows.slice(0, 200).join("\n");
}

function listSessions(): SessionRow[] {
    const dir = expandPath(cfg("sessionsRoot", "")) || path.join(os.homedir(), ".pi", "agent", "sessions");
    const rows: Array<SessionRow & { mtime: number }> = [];
    try {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            const sub = path.join(dir, d.name);
            for (const f of fs.readdirSync(sub)) {
                if (!f.endsWith(".jsonl")) continue;
                const full = path.join(sub, f);
                const st = fs.statSync(full);
                const project = d.name.replace(/^-+/, "/").replace(/-+$/, "").replace(/-/g, "/");
                rows.push({
                    path: full,
                    name: path.basename(project) || project,
                    when: `${relativeTime(st.mtime)} · ${project}`,
                    size: humanBytes(st.size),
                    mtime: st.mtimeMs,
                });
            }
        }
    } catch { /* no sessions yet */ }
    rows.sort((a, b) => b.mtime - a.mtime);
    return rows.slice(0, Math.max(1, cfg("sessionHistoryLimit", 25))).map(({ mtime, ...r }) => r);
}

async function searchFiles(query: string): Promise<Array<{ rel: string; dir: string; path: string }>> {
    const glob = query ? `**/*${query}*` : "**/*";
    const exclude = cfg("fileSearchExclude", "**/{node_modules,.git,out,dist,build,.venv,__pycache__}/**").trim();
    const found = await vscode.workspace.findFiles(glob, exclude || null, 40);
    return found.map((u) => {
        const rel = vscode.workspace.asRelativePath(u);
        return { rel, dir: path.dirname(rel) === "." ? "" : path.dirname(rel), path: u.fsPath };
    });
}

async function insertAtCursor(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        void vscode.window.showWarningMessage("Metwally: open a file first to insert code into it.");
        return;
    }
    await editor.edit((b) => {
        for (const sel of editor.selections) {
            if (sel.isEmpty) b.insert(sel.active, code);
            else b.replace(sel, code);
        }
    });
    void vscode.window.showTextDocument(editor.document, editor.viewColumn);
}

const LANG_ID: Record<string, string> = {
    js: "javascript", jsx: "javascriptreact", ts: "typescript", tsx: "typescriptreact",
    py: "python", rb: "ruby", rs: "rust", sh: "shellscript", bash: "shellscript",
    yml: "yaml", md: "markdown", "c++": "cpp", cs: "csharp", golang: "go",
};

async function openScratch(content: string, lang: string): Promise<void> {
    const language = LANG_ID[lang] ?? (lang || "plaintext");
    const doc = await vscode.workspace.openTextDocument({ content, language });
    await vscode.window.showTextDocument(doc, { preview: false });
}

async function openWorkspaceFile(rel: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const candidate = path.isAbsolute(rel) || !folder ? rel : path.join(folder.uri.fsPath, rel);
    try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(candidate));
        await vscode.window.showTextDocument(doc, { preview: true });
    } catch {
        const hits = await vscode.workspace.findFiles(`**/${path.basename(rel)}`, undefined, 1);
        if (hits.length) await vscode.window.showTextDocument(hits[0], { preview: true });
        else void vscode.window.showWarningMessage(`Metwally: cannot find ${rel}`);
    }
}

/**
 * Read the active terminal's selection. There is no stable API for this, so we
 * round-trip through the clipboard and put the previous contents back.
 */
async function terminalSelection(): Promise<string> {
    if (!vscode.window.activeTerminal) return "";
    const previous = await vscode.env.clipboard.readText();
    // A sentinel, not `previous`: copying a selection that happens to equal the
    // current clipboard would otherwise look like "nothing was selected".
    const sentinel = `\u0000metwally-${Date.now()}`;
    try {
        await vscode.env.clipboard.writeText(sentinel);
        await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
        const copied = await vscode.env.clipboard.readText();
        return copied === sentinel ? "" : copied.trim();
    } catch (err) {
        log(`terminal selection failed: ${(err as Error).message}`);
        return "";
    } finally {
        await vscode.env.clipboard.writeText(previous);
    }
}

function selectionContext(): string | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    const sel = editor.selection;
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const text = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
    const range = sel.isEmpty ? "" : `:${sel.start.line + 1}-${sel.end.line + 1}`;
    const lang = editor.document.languageId;
    return `\`\`\`${lang} ${rel}${range}\n${text}\n\`\`\``;
}

// =============================================================================
// Authoring skills and prompt templates
// =============================================================================

/**
 * Create a skill or prompt template on disk in the location pi scans.
 * Returns the file it wrote, or null when the user backed out.
 */
async function createCommand(kind: CommandKind): Promise<string | null> {
    const label = kind === "skill" ? "skill" : "prompt template";

    // Writing a project resource pi will not read is worse than not offering it.
    const projectTrusted = cfg("trustProject", false);
    const scopePick = await vscode.window.showQuickPick(
        [
            {
                label: "$(globe) Global",
                detail: commandDir(kind, "global", os.homedir(), workingDir()),
                description: "Available in every project",
                scope: "global" as CommandScope,
            },
            {
                label: `$(root-folder) This project${projectTrusted ? "" : " — needs project trust"}`,
                detail: commandDir(kind, "project", os.homedir(), workingDir()),
                description: projectTrusted
                    ? "Checked in with the repo"
                    : "pi ignores project resources until piVscode.trustProject is on",
                scope: "project" as CommandScope,
            },
        ],
        { title: `New ${label} — where should it live?` },
    );
    if (!scopePick) return null;

    if (scopePick.scope === "project" && !projectTrusted) {
        const choice = await vscode.window.showWarningMessage(
            "pi runs in RPC mode, where it never asks about project trust — so it ignores this project's "
            + ".pi/ resources unless piVscode.trustProject is enabled. Enabling it also lets pi load this "
            + "project's settings and run its extensions.",
            { modal: true },
            "Enable project trust", "Use global instead",
        );
        if (choice === "Enable project trust") {
            await vscode.workspace.getConfiguration(CFG).update(
                "trustProject", true, vscode.ConfigurationTarget.Workspace);
        } else if (choice === "Use global instead") {
            scopePick.scope = "global";
        } else {
            return null;
        }
    }

    const name = await vscode.window.showInputBox({
        title: `New ${label} — name`,
        prompt: kind === "skill"
            ? "Invoked as /skill:<name>, and loaded automatically when the description matches"
            : "Invoked as /<name>",
        placeHolder: kind === "skill" ? "pdf-processing" : "review-staged",
        validateInput: (v) => validateCommandName(v) ?? undefined,
    });
    if (!name) return null;

    const description = await vscode.window.showInputBox({
        title: `New ${label} — description`,
        prompt: kind === "skill"
            ? "This decides when the agent loads the skill, so be specific about what it does and when to use it"
            : "Shown in the / autocomplete",
        placeHolder: kind === "skill"
            ? "Extracts text and tables from PDFs. Use when working with PDF documents."
            : "Review the staged git changes",
        validateInput: (v) => (v.trim() ? undefined : "A description is required"),
    });
    if (description === undefined) return null;

    let argumentHint = "";
    if (kind === "prompt") {
        argumentHint = await vscode.window.showInputBox({
            title: "New prompt template — argument hint (optional)",
            prompt: "Shown in autocomplete. <angle> for required, [square] for optional. Leave blank for none.",
            placeHolder: "<PR-URL>",
        }) ?? "";
    }

    const file = commandFile(kind, scopePick.scope, name.trim(), os.homedir(), workingDir());
    if (fs.existsSync(file)) {
        void vscode.window.showErrorMessage(`Metwally: ${vscode.workspace.asRelativePath(file)} already exists.`);
        return null;
    }

    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, kind === "skill"
            ? skillScaffold(name.trim(), description)
            : promptScaffold(name.trim(), description, argumentHint), "utf8");
    } catch (err) {
        void vscode.window.showErrorMessage(`Metwally: cannot write ${file} — ${(err as Error).message}`);
        return null;
    }

    log(`created ${kind}: ${file}`);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: false });
    return file;
}

/** Skills and templates are scanned when pi starts, so a new one needs a restart. */
async function offerRestart(mgr: SessionManager, what: string): Promise<void> {
    const pick = await vscode.window.showInformationMessage(
        `${what} created. pi discovers commands at startup — restart the agent to pick it up?`,
        "Restart Agent", "Later",
    );
    if (pick === "Restart Agent") mgr.restartAll();
}

/** Browse everything pi currently knows about, and act on one. */
async function browseCommands(mgr: SessionManager): Promise<void> {
    const commands = await mgr.commands();
    if (!commands.length) {
        const pick = await vscode.window.showInformationMessage(
            "Metwally: pi reports no skills, prompt templates or extension commands.",
            "New Skill", "New Prompt Template",
        );
        if (pick === "New Skill") await newCommandFlow(mgr, "skill");
        if (pick === "New Prompt Template") await newCommandFlow(mgr, "prompt");
        return;
    }

    const ICON = { skill: "$(lightbulb)", prompt: "$(comment)", extension: "$(plug)" };
    const pick = await vscode.window.showQuickPick(
        commands.map((c) => ({
            label: `${ICON[c.source] ?? "$(circle-outline)"} /${c.name}`,
            description: [c.source, c.scope].filter(Boolean).join(" · "),
            detail: c.description || c.path || "",
            cmd: c,
        })),
        { title: "Metwally — skills and commands", placeHolder: "Pick one to insert, open or delete", matchOnDetail: true },
    );
    if (!pick) return;

    const actions = [
        { label: "$(send) Insert into the chat", act: "insert" },
        ...(pick.cmd.path ? [
            { label: "$(go-to-file) Open the file", act: "open" },
            { label: "$(trash) Delete", act: "delete" },
        ] : []),
    ];
    const action = await vscode.window.showQuickPick(actions, { title: `/${pick.cmd.name}` });
    if (!action) return;

    if (action.act === "insert") {
        mgr.active()?.fill(`/${pick.cmd.name} `, false) ?? mgr.sidebarSession().fill(`/${pick.cmd.name} `, false);
        return;
    }
    if (action.act === "open") {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(pick.cmd.path as string));
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
    }

    const target = pick.cmd.path as string;
    // A skill is a directory; deleting only SKILL.md would leave a broken shell.
    const isSkill = pick.cmd.source === "skill" && path.basename(target) === "SKILL.md";
    const victim = isSkill ? path.dirname(target) : target;
    const yes = await vscode.window.showWarningMessage(
        `Delete ${victim}?${isSkill ? " The whole skill directory is removed." : ""}`,
        { modal: true }, "Delete",
    );
    if (yes !== "Delete") return;
    try {
        fs.rmSync(victim, { recursive: true, force: true });
        void vscode.window.showInformationMessage(`Metwally: deleted /${pick.cmd.name}`);
        mgr.restartAll();
    } catch (err) {
        void vscode.window.showErrorMessage(`Metwally: cannot delete — ${(err as Error).message}`);
    }
}

async function newCommandFlow(mgr: SessionManager, kind: CommandKind): Promise<void> {
    const file = await createCommand(kind);
    if (file) await offerRestart(mgr, kind === "skill" ? "Skill" : "Prompt template");
}

// =============================================================================
// SessionManager — owns every session, the status bar, and the active pointer
// =============================================================================

const SIDEBAR_ID = "sidebar";

class SessionManager {
    private sessions = new Map<string, ChatSession>();
    private status: vscode.StatusBarItem;
    private activeId: string | null = null;
    private counter = 0;

    constructor(context: vscode.ExtensionContext) {
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.status.command = `${CFG}.showSessions`;
        this.refreshStatus();
        this.refreshStatusVisibility();
        context.subscriptions.push(this.status);
    }

    /**
     * The sidebar's session. Kept across view re-resolves so collapsing and
     * reopening the panel does not throw away the conversation.
     */
    sidebarSession(): ChatSession {
        let s = this.sessions.get(SIDEBAR_ID);
        if (!s) {
            s = new ChatSession(SIDEBAR_ID, "Sidebar", (x) => this.onSessionChanged(x));
            // Focusing the view resolves it, so this works before first render.
            s.reveal = () => void vscode.commands.executeCommand(`${CFG}.chatView.focus`);
            this.sessions.set(SIDEBAR_ID, s);
        }
        return s;
    }

    create(): ChatSession {
        const id = `tab-${++this.counter}`;
        const s = new ChatSession(id, `Metwally ${this.counter}`, (x) => this.onSessionChanged(x));
        this.sessions.set(id, s);
        return s;
    }

    /** Tabs only — the sidebar does not count against piVscode.maxSessions. */
    get panelCount(): number {
        return [...this.sessions.keys()].filter((k) => k !== SIDEBAR_ID).length;
    }

    all(): ChatSession[] {
        return [...this.sessions.values()];
    }

    active(): ChatSession | null {
        return (this.activeId ? this.sessions.get(this.activeId) : undefined) ?? null;
    }

    setActive(s: ChatSession): void {
        if (this.activeId === s.id) return;
        this.activeId = s.id;
        void vscode.commands.executeCommand("setContext", `${CFG}.busy`, s.isBusy);
        this.refreshStatus();
    }

    remove(s: ChatSession): void {
        s.dispose();
        this.sessions.delete(s.id);
        if (this.activeId === s.id) this.activeId = null;
        this.refreshStatus();
    }

    private onSessionChanged(s: ChatSession): void {
        if (!this.activeId) this.activeId = s.id;
        // The abort keybinding is gated on this, so it tracks the focused
        // session rather than "any session is streaming".
        if (this.activeId === s.id) {
            void vscode.commands.executeCommand("setContext", `${CFG}.busy`, s.isBusy);
        }
        this.refreshStatus();
    }

    settingsChanged(): void {
        this.refreshStatusVisibility();
        this.refreshStatus();
        for (const s of this.sessions.values()) s.settingsChanged();
    }

    restartAll(): void {
        invalidatePiCache();
        for (const s of this.sessions.values()) s.restart();
    }

    /** pi's command catalogue, from whichever session has a live process. */
    async commands(): Promise<PiCommandInfo[]> {
        for (const s of [this.active(), ...this.sessions.values()]) {
            const list = await s?.fetchCommands();
            if (list) return list;
        }
        return [];
    }

    /** Model changes no longer need a respawn — pi swaps it in place. */
    applyModelAll(): void {
        const m = activeModel();
        for (const s of this.sessions.values()) void s.applyModel(m);
        this.refreshStatus();
    }

    async pick(): Promise<void> {
        const sessions = this.all();
        if (!sessions.length) {
            void vscode.window.showInformationMessage("Metwally: no sessions open.");
            return;
        }
        if (sessions.length === 1) {
            sessions[0].reveal();
            return;
        }
        const activeId = this.active()?.id;
        const choice = await vscode.window.showQuickPick(
            sessions.map((s) => ({
                label: `${s.isBusy ? "$(sync~spin)" : "$(comment-discussion)"} ${s.title}`,
                description: [s.id === SIDEBAR_ID ? "sidebar" : "tab", s.id === activeId ? "active" : ""]
                    .filter(Boolean).join(" · "),
                detail: s.cost !== undefined ? `$${s.cost.toFixed(3)}` : "no activity yet",
                session: s,
            })),
            { title: "Metwally — sessions", placeHolder: "Pick a session to focus" },
        );
        choice?.session.reveal();
    }

    private refreshStatusVisibility(): void {
        if (cfg("showStatusBar", true)) this.status.show();
        else this.status.hide();
    }

    private refreshStatus(): void {
        const m = activeModel();
        const count = this.sessions.size;
        const badge = count > 1 ? ` ${count}` : "";
        const working = this.all().filter((s) => s.isBusy).length;

        if (working) {
            this.status.text = `$(sync~spin) Metwally${badge}`;
            this.status.tooltip = `${working} of ${count} session${count === 1 ? "" : "s"} working — ${m.label}`;
            return;
        }
        const cost = cfg("statusBar.showCost", true) ? this.active()?.cost : undefined;
        this.status.text = `$(zap) Metwally${badge}${cost ? `  $${cost.toFixed(3)}` : ""}`;
        this.status.tooltip = count
            ? `Metwally — ${m.label}\n${count} session${count === 1 ? "" : "s"}\nClick to switch`
            : `Metwally Coding Agent — ${m.label}`;
    }

    dispose(): void {
        for (const s of this.sessions.values()) s.dispose();
        this.sessions.clear();
    }
}

// =============================================================================
// Views
// =============================================================================

class SidebarProvider implements vscode.WebviewViewProvider {
    constructor(private readonly mgr: SessionManager, private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
        };
        view.webview.html = renderHtml(view.webview, this.extensionUri);

        const session = this.mgr.sidebarSession();
        session.reveal = () => void vscode.commands.executeCommand(`${CFG}.chatView.focus`);

        const reg = session.register(view.webview, () => this.mgr.setActive(session));
        const vis = view.onDidChangeVisibility(() => {
            if (view.visible) this.mgr.setActive(session);
        });
        view.onDidDispose(() => {
            reg.dispose();
            vis.dispose();
        });
    }
}

/** Each editor tab is an independent session with its own pi process. */
function openPanel(mgr: SessionManager, extensionUri: vscode.Uri): void {
    const max = Math.max(1, cfg("maxSessions", 4));
    if (mgr.panelCount >= max) {
        void vscode.window.showWarningMessage(
            `Metwally: ${max} chat tabs are already open. Raise piVscode.maxSessions to open more.`,
        );
        mgr.active()?.reveal();
        return;
    }
    bindPanel(mgr, mgr.create(), extensionUri, false);
}

/**
 * Mirror an existing session into an editor tab. A session can own any number of
 * webviews — broadcast() fans out to all of them — so both views stay in sync.
 */
function mirrorSession(mgr: SessionManager, session: ChatSession, extensionUri: vscode.Uri): void {
    bindPanel(mgr, session, extensionUri, true);
}

function bindPanel(mgr: SessionManager, session: ChatSession, extensionUri: vscode.Uri, mirror: boolean): void {
    const panel = vscode.window.createWebviewPanel(
        `${CFG}.chat`,
        mirror ? `${session.title} (mirror)` : session.title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
        },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    panel.webview.html = renderHtml(panel.webview, extensionUri);

    // A mirror must not steal the session's reveal target or its title, and
    // closing it must not kill a session the sidebar still owns.
    if (!mirror) {
        session.reveal = () => panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, false);
        session.onTitle = (t) => { panel.title = t; };
    } else {
        const prev = session.onTitle;
        session.onTitle = (t) => { prev?.(t); panel.title = `${t} (mirror)`; };
    }

    const reg = session.register(panel.webview, () => mgr.setActive(session));
    const state = panel.onDidChangeViewState(() => {
        if (panel.active) mgr.setActive(session);
    });
    panel.onDidDispose(() => {
        reg.dispose();
        state.dispose();
        if (!mirror) mgr.remove(session);
    });
    mgr.setActive(session);
}

// =============================================================================
// Activation
// =============================================================================

export function activate(context: vscode.ExtensionContext): void {
    out = vscode.window.createOutputChannel("Metwally", { log: true });
    context.subscriptions.push(out);

    const mgr = new SessionManager(context);
    context.subscriptions.push(new vscode.Disposable(() => mgr.dispose()));

    // Backs the left-hand side of the edit-review diff.
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, new BeforeContentProvider()),
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(`${CFG}.chatView`, new SidebarProvider(mgr, context.extensionUri), {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    const reg = (id: string, fn: (...a: never[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(`${CFG}.${id}`, fn));

    /** Session that editor commands act on: last focused, else the sidebar. */
    const target = (): ChatSession => mgr.active() ?? mgr.sidebarSession();

    reg("openChat", () => openPanel(mgr, context.extensionUri));
    reg("openSessionInEditor", () => mirrorSession(mgr, target(), context.extensionUri));
    reg("focusView", () => vscode.commands.executeCommand(`${CFG}.chatView.focus`));
    reg("showSessions", () => mgr.pick());
    reg("newSession", () => target().newSession());
    reg("abort", () => target().abort());
    reg("restart", () => mgr.restartAll());
    reg("showLogs", () => out.show());
    reg("newSkill", () => newCommandFlow(mgr, "skill"));
    reg("newPromptTemplate", () => newCommandFlow(mgr, "prompt"));
    reg("browseCommands", () => browseCommands(mgr));
    reg("openSettings", () =>
        vscode.commands.executeCommand("workbench.action.openSettings", "@ext:local.pi-vscode"));

    reg("addSelection", () => {
        const ctx = selectionContext();
        if (!ctx) {
            void vscode.window.showWarningMessage("Metwally: no active editor.");
            return;
        }
        target().fill(`${ctx}\n\n`, false);
    });

    /** One code path for the built-ins and for piVscode.customActions. */
    const runAction = async (def: ActionDef): Promise<void> => {
        const parts = [def.prompt];
        const editor = vscode.window.activeTextEditor;

        if (def.includeDiagnostics && editor) {
            const diags = diagnosticsFor(editor);
            if (diags) parts.push(`Reported diagnostics:\n${diags}`);
        }
        if (def.includeSelection !== false) {
            const ctx = selectionContext();
            if (!ctx) {
                void vscode.window.showWarningMessage(`Metwally: "${def.title}" needs an open editor.`);
                return;
            }
            parts.push(ctx);
        }
        target().fill(parts.join("\n\n"), def.autoSend !== false);
    };

    const runById = (id: string) => async () => {
        const def = allActions().find((a) => a.id === id);
        if (def) await runAction(def);
    };

    reg("explainSelection", runById("explain"));
    reg("fixSelection", runById("fix"));
    reg("testSelection", runById("test"));
    reg("reviewChanges", runById("review"));

    reg("runAction", async () => {
        const actions = allActions();
        const pick = await vscode.window.showQuickPick(
            actions.map((a) => ({
                label: a.title,
                description: a.id,
                detail: a.prompt.length > 110 ? `${a.prompt.slice(0, 110)}...` : a.prompt,
                def: a,
            })),
            { title: "Metwally — run action", placeHolder: "Add your own with piVscode.customActions" },
        );
        if (pick) await runAction(pick.def);
    });

    reg("commitMessage", () => {
        target().fill(
            "Write a commit message for the staged changes in this repository. " +
            "Run `git diff --cached` to see them; if nothing is staged, use `git diff` instead. " +
            "Reply with the message only — a concise subject line, then a body explaining why.",
            true,
        );
    });

    // Explorer entries arrive as (clickedUri, selectedUris); the second form is
    // what a multi-select right-click sends.
    reg("addFileToChat", (...args: unknown[]) => {
        const [clicked, selected] = args as [vscode.Uri | undefined, vscode.Uri[] | undefined];
        const uris = selected?.length ? selected : clicked ? [clicked] : [];
        const session = target();
        for (const uri of uris) session.attach(uri);
    });

    reg("explainTerminal", async () => {
        const text = await terminalSelection();
        if (!text) {
            void vscode.window.showWarningMessage("Metwally: select some terminal output first.");
            return;
        }
        target().fill(
            `Explain this terminal output. Identify the first meaningful error, classify the failure, ` +
            `and propose one minimal fix.\n\n\`\`\`\n${text.slice(0, 20_000)}\n\`\`\``,
            true,
        );
    });

    // Only settings that change how pi is launched force a restart; cosmetic
    // ones must not throw away a running conversation.
    // Only arguments baked into the command line need a respawn. The model is
    // swapped in place via set_model, so switching it no longer costs a process.
    const RESPAWN_KEYS = [
        "piPath", "providerScript", "noSession",
        "sessionDir", "env", "extraArgs", "workingDirectory", "trustProject",
    ];
    const MODEL_KEYS = ["model", "provider", "models", "modelLabel", "contextWindow"];
    const VIEW_KEYS = ["showThinking", "defaultEffort", "showStatusBar", "statusBar", "reviewEdits"];
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            const hit = (keys: string[]) => keys.some((k) => e.affectsConfiguration(`${CFG}.${k}`));
            if (hit(RESPAWN_KEYS)) mgr.restartAll();
            else if (hit(MODEL_KEYS)) mgr.applyModelAll();
            else if (hit(VIEW_KEYS)) mgr.settingsChanged();
        }),
    );

    log("Metwally activated");
}

export function deactivate(): void {
    /* sessions are disposed through context.subscriptions */
}
