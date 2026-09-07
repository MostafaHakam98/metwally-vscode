/**
 * Pure helpers with no `vscode` import.
 *
 * Everything here is reachable from a plain Node test runner; anything that
 * needs the extension host lives in extension.ts and takes its inputs from
 * these functions. Keep this file dependency-free.
 */

import * as path from "path";

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

/** Expand `~` and `${workspaceFolder}` in a user-supplied path setting. */
export function expandPath(raw: string, home: string, workspaceFolder: string): string {
    let out = (raw ?? "").trim();
    if (!out) return "";
    out = out.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
    if (out === "~") return home;
    if (out.startsWith("~/")) out = path.join(home, out.slice(2));
    return out;
}

/**
 * Tool arguments name the edited file inconsistently across tools, so accept
 * the spellings pi's built-in tools actually use. Relative paths resolve
 * against the agent's working directory.
 */
export function filePathFromArgs(args: Record<string, unknown> | undefined, cwd: string): string | null {
    if (!args) return null;
    for (const key of ["file_path", "filePath", "path", "abs_path", "file"]) {
        const v = args[key];
        if (typeof v === "string" && v.trim()) {
            return path.isAbsolute(v) ? v : path.join(cwd, v);
        }
    }
    return null;
}

// -----------------------------------------------------------------------------
// Diffing
// -----------------------------------------------------------------------------

/**
 * Approximate added/removed line counts by trimming the common prefix and
 * suffix. Not an LCS diff — enough for a summary chip, while the diff view
 * itself shows the truth.
 */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
    // "".split("\n") is [""], not []: without this an empty file counts as one
    // line and creating a file reports a phantom removal.
    const a = before === "" ? [] : before.split("\n");
    const b = after === "" ? [] : after.split("\n");
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head
        && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return {
        removed: Math.max(0, a.length - head - tail),
        added: Math.max(0, b.length - head - tail),
    };
}

// -----------------------------------------------------------------------------
// Prompt and context
// -----------------------------------------------------------------------------

/**
 * Name a chat tab after its first prompt. Skips fences, rules and bracketed
 * markers so the title is the sentence the user actually wrote.
 */
export function titleFromPrompt(text: string, max = 32): string | null {
    let inFence = false;
    for (const raw of (text ?? "").split("\n")) {
        const line = raw.trim();
        // Track fences rather than just skipping their delimiters, or a prompt
        // that leads with a code block gets titled with a line of code.
        if (line.startsWith("```")) { inFence = !inFence; continue; }
        if (inFence || !line || line.startsWith("---") || line.startsWith("[")) continue;
        return line.length > max ? `${line.slice(0, max).trimEnd()}...` : line;
    }
    return null;
}

/** Clip a file for prompt context, saying so rather than truncating silently. */
export function truncateForContext(body: string, limit: number): string {
    if (body.length <= limit) return body;
    return `${body.slice(0, limit)}\n... [truncated ${body.length - limit} characters]`;
}

/** Rough token estimate: ~4 characters per token. Displayed as an estimate. */
export function estimateTokens(bytes: number): number {
    return Math.ceil(bytes / 4);
}

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

export function humanBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function relativeTime(d: Date, now = Date.now()): string {
    const mins = Math.round((now - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return d.toISOString().slice(0, 10);
}

/** Concatenate the text parts of a tool result. */
export function textOf(result?: { content?: Array<{ type: string; text?: string }> }): string {
    if (!result?.content) return "";
    return result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}
