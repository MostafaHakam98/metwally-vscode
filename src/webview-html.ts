import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

function nonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

/**
 * Loads media/webview/index.html and substitutes the {{...}} placeholders with
 * webview-safe URIs plus a fresh CSP nonce.
 */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const root = vscode.Uri.joinPath(extensionUri, "media", "webview");
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, file)).toString();

    const htmlPath = path.join(extensionUri.fsPath, "media", "webview", "index.html");
    const raw = fs.readFileSync(htmlPath, "utf8");

    const tokens: Record<string, string> = {
        cspSource: webview.cspSource,
        nonce: nonce(),
        styleUri: uri("style.css"),
        scriptUri: uri("main.js"),
        markdownUri: uri("markdown.js"),
        highlightUri: uri("highlight.js"),
    };

    return raw.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => tokens[key] ?? "");
}
