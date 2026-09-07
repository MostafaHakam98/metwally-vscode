import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { PiRpcClient, UsageInfo } from "./rpc-client";
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

// =============================================================================
// Logging — a real output channel beats appending to a temp file.
// =============================================================================

let out: vscode.LogOutputChannel;
const log = (msg: string) => out?.appendLine(msg);

// =============================================================================
// pi binary resolution
// =============================================================================

function resolvePiPath(): string {
    const configured = cfg("piPath", "pi");
    if (configured.startsWith("/") && fs.existsSync(configured)) return configured;

    const candidates: string[] = [];
    const nvmDir = path.join(os.homedir(), ".nvm", "versions", "node");
    try {
        for (const d of fs.readdirSync(nvmDir, { withFileTypes: true })) {
            if (d.isDirectory()) candidates.push(path.join(nvmDir, d.name, "bin", "pi"));
        }
    } catch { /* nvm not installed */ }
    candidates.push("/usr/local/bin/pi", path.join(os.homedir(), ".local", "bin", "pi"));

    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
    return configured || "pi";
}

// =============================================================================
// ChatController — owns the pi process and fans events out to every open view
// =============================================================================

interface Attachment {
    kind: "image" | "file" | "ref";
    name: string;
    data?: string;
    mimeType?: string;
    content?: string;
    path?: string;
}

class ChatController {
    private client: PiRpcClient | null = null;
    private views = new Set<vscode.Webview>();
    private status: vscode.StatusBarItem;
    private busy = false;
    private usage: UsageInfo | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.status.command = `${CFG}.focusView`;
        this.refreshStatus();
        if (cfg("showStatusBar", true)) this.status.show();
        context.subscriptions.push(this.status);
    }

    // --- view registry -------------------------------------------------------

    register(webview: vscode.Webview): vscode.Disposable {
        this.views.add(webview);
        const sub = webview.onDidReceiveMessage((m) => this.onMessage(m, webview));
        this.sendInit(webview);
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
        void webview.postMessage({
            type: "init",
            model: m.id,
            modelLabel: m.label,
            provider: m.provider,
            contextWindow: m.contextWindow,
            cwd: folder?.uri.fsPath ?? process.cwd(),
            workspace: folder?.name ?? "",
        });
        if (this.usage) void webview.postMessage({ type: "usage", usage: this.usage });
    }

    private refreshStatus(): void {
        const m = activeModel();
        if (this.busy) {
            this.status.text = "$(sync~spin) Metwally";
            this.status.tooltip = `Metwally is working — ${m.label}`;
        } else {
            const cost = this.usage?.cost?.total;
            this.status.text = cost ? `$(zap) Metwally  $${cost.toFixed(3)}` : "$(zap) Metwally";
            this.status.tooltip = `Metwally Coding Agent — ${m.label}\nClick to open the chat`;
        }
    }

    // --- pi process ----------------------------------------------------------

    private ensureClient(): PiRpcClient {
        if (this.client) return this.client;

        const workDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const piPath = resolvePiPath();
        const model = activeModel();

        // The setting declares "" as its default, so an empty value means
        // "unset" and we fall back to the checked-in vLLM provider script.
        const extraArgs: string[] = [];
        const configured = cfg("providerScript", "").trim();
        const scriptPath = configured || path.join(os.homedir(), "pi-vscode", "pi-config", "extensions", "vllm-stream.ts");
        if (fs.existsSync(scriptPath)) {
            extraArgs.push("-e", scriptPath);
            log(`provider script: ${scriptPath}`);
        } else if (configured) {
            log(`provider script not found, ignoring: ${scriptPath}`);
        }

        log(`spawn: ${piPath} (cwd=${workDir}, model=${model.id}, provider=${model.provider})`);

        const client = new PiRpcClient({
            piPath,
            cwd: workDir,
            noSession: cfg("noSession", false),
            provider: model.provider,
            model: model.id,
            extraArgs,
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
        return client;
    }

    private onAgentEvent(ev: AnyEvent): void {
        switch (ev.type) {
            case "agent_start":
                this.setBusy(true);
                break;

            case "agent_settled":
                this.setBusy(false);
                this.broadcast({ type: "message-end" });
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

            case "tool_execution_start":
                this.broadcast({ type: "tool-start", toolName: ev.toolName, args: ev.args });
                break;

            case "tool_execution_update":
                this.broadcast({ type: "tool-update", output: textOf(ev.partialResult) });
                break;

            case "tool_execution_end":
                this.broadcast({ type: "tool-end", output: textOf(ev.result), isError: !!ev.isError });
                break;

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
        this.refreshStatus();
        void vscode.commands.executeCommand("setContext", `${CFG}.busy`, on);
    }

    private setUsage(u: UsageInfo): void {
        this.usage = u;
        this.broadcast({ type: "usage", usage: u });
        this.refreshStatus();
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
                    await this.ensureClient().send({ type: "switch_session", sessionPath: msg.path } as never);
                    this.broadcast({ type: "clear" });
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

            case "resolve-uri": {
                const uri = vscode.Uri.parse(String(msg.uri ?? ""));
                this.broadcast({
                    type: "attachment",
                    attachment: { kind: "ref", name: vscode.workspace.asRelativePath(uri), path: uri.fsPath },
                });
                break;
            }
        }
    }

    // --- actions -------------------------------------------------------------

    async submit(text: string, attachments: Attachment[], effort: string): Promise<void> {
        if (!text.trim() && !attachments.length) return;

        this.broadcast({ type: "user-message", text, attachments: attachments.map((a) => ({ kind: a.kind, name: a.name })) });
        this.setBusy(true);

        const images: Array<{ data: string; mimeType: string }> = [];
        const context: string[] = [];

        for (const a of attachments) {
            if (a.kind === "image" && a.data) {
                images.push({ data: a.data, mimeType: a.mimeType ?? "image/png" });
            } else if (a.kind === "ref" && a.path) {
                try {
                    const body = fs.readFileSync(a.path, "utf8").slice(0, 120_000);
                    context.push(`--- ${a.name} ---\n${body}`);
                } catch (err) {
                    context.push(`--- ${a.name} (unreadable: ${(err as Error).message}) ---`);
                }
            } else if (a.content) {
                context.push(`--- ${a.name} ---\n${a.content}`);
            }
        }

        let full = text;
        if (context.length) full = `${context.join("\n\n")}\n\n${text}`;
        if (effort && effort !== "off") full = `[reasoning: ${effort}]\n\n${full}`;
        full = `[IMPORTANT: After thinking, you MUST produce a clear, concise final answer. Never leave it empty.]\n\n${full}`;

        const cmd: Record<string, unknown> = { type: "prompt", message: full };
        if (images.length) cmd.images = images;

        try {
            await this.ensureClient().send(cmd as never, cfg("requestTimeoutMs", 600_000));
        } catch (err) {
            this.broadcast({ type: "error", text: (err as Error).message });
            this.setBusy(false);
        }
    }

    async newSession(): Promise<void> {
        try {
            await this.ensureClient().send({ type: "new_session" } as never, 30_000);
        } catch (err) {
            log(`new_session failed: ${(err as Error).message}`);
        }
        this.usage = null;
        this.refreshStatus();
        this.broadcast({ type: "clear" });
    }

    abort(): void {
        this.client?.sendFire({ type: "abort" });
        this.setBusy(false);
    }

    /** Drop the pi process so the next prompt respawns it with fresh settings. */
    restart(): void {
        this.client?.kill();
        this.client = null;
        this.setBusy(false);
        for (const v of this.views) this.sendInit(v);
        this.broadcast({ type: "toast", text: "Agent restarted with the new settings" });
    }

    /** Push text into the composer of whichever view is open. */
    fill(text: string, autoSend: boolean): void {
        this.broadcast({ type: "set-input", text, send: autoSend });
    }

    private async pickAttachment(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: "Attach",
            defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (!picked) return;

        for (const uri of picked) {
            const ext = path.extname(uri.fsPath).toLowerCase();
            const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext);
            try {
                const data = fs.readFileSync(uri.fsPath);
                if (isImage) {
                    const mime = ext === ".png" ? "image/png"
                        : ext === ".gif" ? "image/gif"
                        : ext === ".webp" ? "image/webp"
                        : ext === ".bmp" ? "image/bmp"
                        : "image/jpeg";
                    this.broadcast({
                        type: "attachment",
                        attachment: { kind: "image", name: path.basename(uri.fsPath), data: data.toString("base64"), mimeType: mime },
                    });
                } else {
                    this.broadcast({
                        type: "attachment",
                        attachment: { kind: "ref", name: vscode.workspace.asRelativePath(uri), path: uri.fsPath },
                    });
                }
            } catch (err) {
                this.broadcast({ type: "toast", kind: "err", text: `Cannot read ${path.basename(uri.fsPath)}` });
                log(`attach failed: ${(err as Error).message}`);
            }
        }
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
            { title: "Metwally — select model", placeHolder: "Restarts the agent process" },
        );
        if (!pick) return;

        await vscode.workspace.getConfiguration(CFG).update("model", pick.model.id, vscode.ConfigurationTarget.Global);
        this.broadcast({ type: "model", model: pick.model.id, modelLabel: pick.model.label, contextWindow: pick.model.contextWindow });
        this.broadcast({ type: "toast", text: `Switched to ${pick.model.label}` });
        this.refreshStatus();
    }

    dispose(): void {
        this.client?.kill();
        this.client = null;
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

function textOf(result?: { content?: Array<{ type: string; text?: string }> }): string {
    if (!result?.content) return "";
    return result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

function humanBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function relativeTime(d: Date): string {
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return d.toISOString().slice(0, 10);
}

interface SessionRow { path: string; name: string; when: string; size: string; }

function listSessions(): SessionRow[] {
    const dir = path.join(os.homedir(), ".pi", "agent", "sessions");
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
    return rows.slice(0, 25).map(({ mtime, ...r }) => r);
}

async function searchFiles(query: string): Promise<Array<{ rel: string; dir: string; path: string }>> {
    const glob = query ? `**/*${query}*` : "**/*";
    const found = await vscode.workspace.findFiles(glob, "**/{node_modules,.git,out,dist,build,.venv,__pycache__}/**", 40);
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
// Views
// =============================================================================

class SidebarProvider implements vscode.WebviewViewProvider {
    constructor(private readonly ctrl: ChatController, private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
        };
        view.webview.html = renderHtml(view.webview, this.extensionUri);
        const reg = this.ctrl.register(view.webview);
        view.onDidDispose(() => reg.dispose());
    }
}

let panel: vscode.WebviewPanel | null = null;

function openPanel(ctrl: ChatController, extensionUri: vscode.Uri): void {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Beside);
        return;
    }
    panel = vscode.window.createWebviewPanel(
        `${CFG}.chat`,
        "Metwally",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
        },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    panel.webview.html = renderHtml(panel.webview, extensionUri);
    const reg = ctrl.register(panel.webview);
    panel.onDidDispose(() => {
        reg.dispose();
        panel = null;
    });
}

// =============================================================================
// Activation
// =============================================================================

export function activate(context: vscode.ExtensionContext): void {
    out = vscode.window.createOutputChannel("Metwally", { log: true });
    context.subscriptions.push(out);

    const ctrl = new ChatController(context);
    context.subscriptions.push(new vscode.Disposable(() => ctrl.dispose()));

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(`${CFG}.chatView`, new SidebarProvider(ctrl, context.extensionUri), {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    const reg = (id: string, fn: (...a: never[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(`${CFG}.${id}`, fn));

    reg("openChat", () => openPanel(ctrl, context.extensionUri));
    reg("focusView", () => vscode.commands.executeCommand(`${CFG}.chatView.focus`));
    reg("newSession", () => ctrl.newSession());
    reg("abort", () => ctrl.abort());
    reg("showLogs", () => out.show());

    reg("addSelection", async () => {
        const ctx = selectionContext();
        if (!ctx) {
            void vscode.window.showWarningMessage("Metwally: no active editor.");
            return;
        }
        await vscode.commands.executeCommand(`${CFG}.chatView.focus`);
        ctrl.fill(`${ctx}\n\n`, false);
    });

    reg("explainSelection", async () => {
        const ctx = selectionContext();
        if (!ctx) return;
        await vscode.commands.executeCommand(`${CFG}.chatView.focus`);
        ctrl.fill(`Explain this code — what it does, why it is written this way, and anything risky about it.\n\n${ctx}`, true);
    });

    reg("testSelection", async () => {
        const ctx = selectionContext();
        if (!ctx) return;
        await vscode.commands.executeCommand(`${CFG}.chatView.focus`);
        ctrl.fill(`Write focused tests for this code, then run them.\n\n${ctx}`, true);
    });

    reg("fixSelection", async () => {
        const ctx = selectionContext();
        if (!ctx) return;
        const editor = vscode.window.activeTextEditor;
        const diags = editor
            ? vscode.languages.getDiagnostics(editor.document.uri)
                .filter((d) => !editor.selection.isEmpty ? d.range.intersection(editor.selection) : true)
                .slice(0, 20)
                .map((d) => `- [${vscode.DiagnosticSeverity[d.severity]}] line ${d.range.start.line + 1}: ${d.message}`)
                .join("\n")
            : "";
        await vscode.commands.executeCommand(`${CFG}.chatView.focus`);
        ctrl.fill(
            `Fix the problems in this code.${diags ? `\n\nReported diagnostics:\n${diags}` : ""}\n\n${ctx}`,
            true,
        );
    });

    reg("reviewChanges", async () => {
        await vscode.commands.executeCommand(`${CFG}.chatView.focus`);
        ctrl.fill("Review my uncommitted changes for correctness, maintainability and CI impact. Tag each finding by severity.", true);
    });

    // Only settings that change how pi is launched force a restart; cosmetic
    // ones must not throw away a running conversation.
    const RESPAWN_KEYS = ["model", "provider", "piPath", "providerScript", "noSession", "models"];
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (RESPAWN_KEYS.some((k) => e.affectsConfiguration(`${CFG}.${k}`))) ctrl.restart();
        }),
    );

    log("Metwally activated");
}

export function deactivate(): void {
    panel?.dispose();
    panel = null;
}
