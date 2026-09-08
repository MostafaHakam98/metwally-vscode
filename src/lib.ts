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

// -----------------------------------------------------------------------------
// Skills and prompt templates
//
// Formats and locations follow pi's own docs (docs/skills.md,
// docs/prompt-templates.md). Discovery happens when pi starts, so anything
// created here needs an agent restart before it is visible.
// -----------------------------------------------------------------------------

export type CommandKind = "skill" | "prompt";
export type CommandScope = "global" | "project";

/**
 * pi names must be 1-64 chars of lowercase letters, digits and single hyphens,
 * with no leading or trailing hyphen. Returns an error message, or null when
 * the name is valid.
 */
export function validateCommandName(name: string): string | null {
    const n = (name ?? "").trim();
    if (!n) return "Name is required";
    if (n.length > 64) return "Name must be 64 characters or fewer";
    if (n !== n.toLowerCase()) return "Use lowercase letters only";
    if (!/^[a-z0-9-]+$/.test(n)) return "Use only lowercase letters, digits and hyphens";
    if (n.startsWith("-") || n.endsWith("-")) return "Name cannot start or end with a hyphen";
    if (n.includes("--")) return "Name cannot contain consecutive hyphens";
    return null;
}

/** Best-effort conversion of free text into a valid command name. */
export function slugify(text: string): string {
    return (text ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64)
        .replace(/-$/, "");
}

/**
 * Directory pi scans for a given kind and scope.
 *
 * Global lives under the pi home; project lives under `.pi/` in the working
 * directory and is only loaded once the project is trusted.
 */
export function commandDir(
    kind: CommandKind, scope: CommandScope, home: string, workDir: string,
): string {
    if (scope === "global") {
        return path.join(home, ".pi", "agent", kind === "skill" ? "skills" : "prompts");
    }
    return path.join(workDir, ".pi", kind === "skill" ? "skills" : "prompts");
}

/** Where the file for a new command goes: skills are a directory with SKILL.md. */
export function commandFile(
    kind: CommandKind, scope: CommandScope, name: string, home: string, workDir: string,
): string {
    const dir = commandDir(kind, scope, home, workDir);
    return kind === "skill"
        ? path.join(dir, name, "SKILL.md")
        : path.join(dir, `${name}.md`);
}

/** How the command is typed in the composer. */
export function commandInvocation(kind: CommandKind, name: string): string {
    return kind === "skill" ? `/skill:${name}` : `/${name}`;
}

function yamlValue(s: string): string {
    // Quote when the value could otherwise be misread as YAML structure.
    const v = (s ?? "").replace(/\r?\n/g, " ").trim();
    return /^[\w][\w .,'()/-]*$/.test(v) ? v : JSON.stringify(v);
}

export function skillScaffold(name: string, description: string): string {
    return `---
name: ${name}
description: ${yamlValue(description)}
---

# ${name}

## When to use

${description}

## Steps

1. Describe the first step.
2. Reference bundled files with relative paths, for example \`scripts/run.sh\`.

## Notes

Anything the agent should know before acting.
`;
}

export function promptScaffold(name: string, description: string, argumentHint: string): string {
    const front = [`description: ${yamlValue(description)}`];
    if (argumentHint.trim()) front.push(`argument-hint: ${JSON.stringify(argumentHint.trim())}`);
    return `---
${front.join("\n")}
---
Describe what the agent should do when \`/${name}\` is used.

Arguments are available as $1, $2 and $@ (all of them).
Use \${1:-default} to give an argument a fallback.
`;
}

/**
 * A message that pi expands itself — a prompt template, skill or extension
 * command. These must reach pi with the slash at position 0, so no preamble or
 * attached context may be prepended.
 */
export function isPiCommand(message: string): boolean {
    return /^\/[A-Za-z0-9][\w:-]*(\s|$)/.test((message ?? "").trimStart());
}

/**
 * One command from pi's `get_commands`.
 *
 * pi 0.84.4 nests the origin under `sourceInfo`, while the RPC docs show flat
 * `path`/`location` fields. Accept both so the UI keeps working either way.
 */
export interface RawPiCommand {
    name: string;
    description?: string;
    source: "extension" | "prompt" | "skill";
    location?: string;
    path?: string;
    sourceInfo?: { path?: string; scope?: string };
}

export interface PiCommandInfo {
    name: string;
    description: string;
    source: "extension" | "prompt" | "skill";
    scope: string;
    path: string;
}

export function normalizePiCommand(raw: RawPiCommand): PiCommandInfo {
    return {
        name: raw.name,
        description: (raw.description ?? "").trim(),
        source: raw.source,
        scope: raw.location ?? raw.sourceInfo?.scope ?? "",
        path: raw.path ?? raw.sourceInfo?.path ?? "",
    };
}

// -----------------------------------------------------------------------------
// Importing resources from other agent harnesses
//
// pi already loads whole directories through the `skills` and `prompts` arrays
// in settings.json, and Claude Code / Codex use the same Agent Skills layout
// and $1/$ARGUMENTS template syntax. So importing means linking a directory,
// not copying and converting files — edits on either side stay in sync.
// -----------------------------------------------------------------------------

export type HarnessKind = "skills" | "prompts";

export interface HarnessSource {
    /** Stable id, used to match a source against what is already linked. */
    id: string;
    harness: string;
    kind: HarnessKind;
    /** Absolute directory on disk. */
    dir: string;
    label: string;
    detail: string;
}

/**
 * Directories worth offering. pi already scans `~/.agents/skills`,
 * `~/.pi/agent/*` and project `.agents/skills` on its own, so those are
 * deliberately absent — linking them would be a no-op.
 */
export function harnessCandidates(home: string, workDir: string): HarnessSource[] {
    const mk = (
        harness: string, kind: HarnessKind, dir: string, label: string, detail: string,
    ): HarnessSource => ({ id: `${harness}:${kind}:${dir}`, harness, kind, dir, label, detail });

    return [
        mk("Claude Code", "skills", path.join(home, ".claude", "skills"),
            "Claude Code skills", "Global — ~/.claude/skills"),
        mk("Claude Code", "prompts", path.join(home, ".claude", "commands"),
            "Claude Code slash commands", "Global — ~/.claude/commands, loaded as prompt templates"),
        mk("Codex", "skills", path.join(home, ".codex", "skills"),
            "Codex skills", "Global — ~/.codex/skills"),
        mk("Codex", "prompts", path.join(home, ".codex", "prompts"),
            "Codex prompts", "Global — ~/.codex/prompts, loaded as prompt templates"),
        mk("Claude Code", "skills", path.join(workDir, ".claude", "skills"),
            "Claude Code skills (this project)", "Project — .claude/skills"),
        mk("Claude Code", "prompts", path.join(workDir, ".claude", "commands"),
            "Claude Code slash commands (this project)", "Project — .claude/commands"),
        mk("Codex", "skills", path.join(workDir, ".codex", "skills"),
            "Codex skills (this project)", "Project — .codex/skills"),
        mk("Codex", "prompts", path.join(workDir, ".codex", "prompts"),
            "Codex prompts (this project)", "Project — .codex/prompts"),
    ];
}

/** Store `~/...` where possible; pi resolves it and it survives a moved home. */
export function tildify(p: string, home: string): string {
    if (!home || !p.startsWith(home)) return p;
    const rest = p.slice(home.length).replace(/^[/\\]/, "");
    return rest ? `~/${rest}` : "~";
}

export function untildify(p: string, home: string): string {
    if (p === "~") return home;
    return p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

export function settingsPathFor(scope: CommandScope, home: string, workDir: string): string {
    return scope === "global"
        ? path.join(home, ".pi", "agent", "settings.json")
        : path.join(workDir, ".pi", "settings.json");
}

/**
 * Apply a selection to one settings array.
 *
 * Entries the user added by hand are preserved: only paths that this importer
 * knows about (`managed`) are removed when deselected, so the multi-select acts
 * as a toggle rather than overwriting the array.
 */
export function applyLinkSelection(
    existing: string[], managed: string[], selected: string[], home: string,
): string[] {
    const norm = (p: string) => path.normalize(untildify(p, home)).replace(/[/\\]+$/, "");
    const managedSet = new Set(managed.map(norm));
    const kept = (existing ?? []).filter((e) => !managedSet.has(norm(e)));
    const out = [...kept];
    for (const s of selected) {
        const tilde = tildify(s, home);
        if (!out.some((e) => norm(e) === norm(tilde))) out.push(tilde);
    }
    return out;
}

/** Which managed directories a settings array currently links. */
export function linkedFrom(existing: string[], managed: string[], home: string): string[] {
    const norm = (p: string) => path.normalize(untildify(p, home)).replace(/[/\\]+$/, "");
    const have = new Set((existing ?? []).map(norm));
    return managed.filter((m) => have.has(norm(m)));
}

// -----------------------------------------------------------------------------
// Session history
// -----------------------------------------------------------------------------

export interface StoredMessage {
    role: string;
    content?: unknown;
}

export interface HistoryEntry {
    role: "user" | "assistant";
    text: string;
}

/** Join the text blocks of one stored message, ignoring thinking and tool calls. */
export function messageText(msg: StoredMessage): string {
    const c = msg?.content;
    if (typeof c === "string") return c;
    if (!Array.isArray(c)) return "";
    return c
        .filter((b): b is { type: string; text?: string } =>
            !!b && typeof b === "object" && (b as { type?: string }).type === "text")
        .map((b) => b.text ?? "")
        .join("");
}

/**
 * Turn a restored session into something renderable.
 *
 * Tool results and reasoning are dropped: they are not persisted per-turn by
 * the view, and replaying them out of order would misrepresent the session.
 * The preamble and any context blocks this extension prepended are stripped so
 * a restored prompt reads as what the user typed.
 */
export function historyFromMessages(
    messages: StoredMessage[], preamble: string, limit = 4000,
): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    for (const m of messages ?? []) {
        const role = m?.role === "user" ? "user" : m?.role === "assistant" ? "assistant" : null;
        if (!role) continue;
        let text = messageText(m).trim();
        if (!text) continue;
        if (role === "user") text = stripInjectedContext(text, preamble);
        if (!text) continue;
        if (text.length > limit) text = `${text.slice(0, limit)}\n\n_… truncated_`;
        out.push({ role, text });
    }
    return out;
}

/**
 * Remove what submit() prepends: the configured preamble, a reasoning marker
 * from older sessions, and any `--- name ---` context sections.
 */
export function stripInjectedContext(text: string, preamble: string): string {
    let out = text;
    const p = (preamble ?? "").trim();
    if (p && out.startsWith(p)) out = out.slice(p.length);
    out = out.replace(/^\s*\[reasoning: \w+\]\s*/, "");
    // Context sections are emitted as "--- name ---" followed by a file body.
    // The user's own text is whatever follows the last one.
    const marks = [...out.matchAll(/^--- .+ ---$/gm)];
    if (marks.length) {
        const last = marks[marks.length - 1];
        const after = out.slice((last.index ?? 0) + last[0].length);
        const blank = after.indexOf("\n\n");
        if (blank !== -1) out = after.slice(blank + 2);
    }
    return out.trim();
}
