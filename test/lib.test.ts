import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import {
    estimateTokens, expandPath, filePathFromArgs, finalAgentError, humanBytes,
    lineDelta, relativeTime, textOf, titleFromPrompt, truncateForContext,
} from "../src/lib";

const HOME = "/home/u";
const WS = "/work/proj";

test("expandPath leaves absolute paths alone", () => {
    assert.equal(expandPath("/usr/local/bin/pi", HOME, WS), "/usr/local/bin/pi");
});

test("expandPath expands ~ and ~/", () => {
    assert.equal(expandPath("~", HOME, WS), HOME);
    assert.equal(expandPath("~/.local/bin/pi", HOME, WS), path.join(HOME, ".local/bin/pi"));
});

test("expandPath does not expand a bare ~ inside a path segment", () => {
    // "~foo" is a real relative directory name, not a home reference.
    assert.equal(expandPath("~foo/bar", HOME, WS), "~foo/bar");
});

test("expandPath substitutes every ${workspaceFolder}", () => {
    assert.equal(expandPath("${workspaceFolder}/a/${workspaceFolder}", HOME, WS), `${WS}/a/${WS}`);
});

test("expandPath treats blank and whitespace as unset", () => {
    assert.equal(expandPath("", HOME, WS), "");
    assert.equal(expandPath("   ", HOME, WS), "");
});

test("filePathFromArgs accepts each spelling tools use", () => {
    for (const key of ["file_path", "filePath", "path", "abs_path", "file"]) {
        assert.equal(filePathFromArgs({ [key]: "/abs/x.ts" }, WS), "/abs/x.ts", key);
    }
});

test("filePathFromArgs resolves relative paths against the working dir", () => {
    assert.equal(filePathFromArgs({ path: "src/a.ts" }, WS), path.join(WS, "src/a.ts"));
});

test("filePathFromArgs prefers file_path over looser keys", () => {
    // A tool that passes both must not be diffed against the wrong file.
    assert.equal(filePathFromArgs({ file: "/b.ts", file_path: "/a.ts" }, WS), "/a.ts");
});

test("filePathFromArgs ignores non-string and empty values", () => {
    assert.equal(filePathFromArgs({ path: 42 } as never, WS), null);
    assert.equal(filePathFromArgs({ path: "   " }, WS), null);
    assert.equal(filePathFromArgs(undefined, WS), null);
    assert.equal(filePathFromArgs({ command: "ls -la" }, WS), null, "bash tools name no file");
});

test("lineDelta reports a pure insertion", () => {
    assert.deepEqual(lineDelta("a\nb", "a\nx\ny\nb"), { added: 2, removed: 0 });
});

test("lineDelta reports a pure deletion", () => {
    assert.deepEqual(lineDelta("a\nx\nb", "a\nb"), { added: 0, removed: 1 });
});

test("lineDelta reports a replacement on both sides", () => {
    assert.deepEqual(lineDelta("a\nx\nb", "a\ny\nb"), { added: 1, removed: 1 });
});

test("lineDelta returns zeros for identical content", () => {
    assert.deepEqual(lineDelta("a\nb\nc", "a\nb\nc"), { added: 0, removed: 0 });
});

test("lineDelta handles creation from empty and never goes negative", () => {
    const created = lineDelta("", "a\nb");
    assert.equal(created.removed, 0);
    assert.ok(created.added > 0);
    for (const [a, b] of [["", ""], ["a", ""], ["a\na\na", "a"]]) {
        const d = lineDelta(a, b);
        assert.ok(d.added >= 0 && d.removed >= 0, `${JSON.stringify([a, b])} -> ${JSON.stringify(d)}`);
    }
});

test("titleFromPrompt takes the first real line", () => {
    assert.equal(titleFromPrompt("Fix the parser\nmore detail"), "Fix the parser");
});

test("titleFromPrompt skips fences, rules and bracketed markers", () => {
    assert.equal(titleFromPrompt("[reasoning: high]\n\n```ts\ncode\n```\n---\nExplain this"), "Explain this");
});

test("titleFromPrompt truncates with an ellipsis and trims the seam", () => {
    const t = titleFromPrompt("x".repeat(60)) as string;
    assert.equal(t.length, 35);
    assert.ok(t.endsWith("..."));
    assert.equal(titleFromPrompt(`${"a".repeat(30)}     tail`), `${"a".repeat(30)}...`);
});

test("titleFromPrompt returns null when there is no usable line", () => {
    assert.equal(titleFromPrompt(""), null);
    assert.equal(titleFromPrompt("```\ncode\n```"), null);
    assert.equal(titleFromPrompt("   \n  \n"), null);
});

test("truncateForContext is a no-op under the limit", () => {
    assert.equal(truncateForContext("short", 100), "short");
    assert.equal(truncateForContext("exact", 5), "exact", "boundary is inclusive");
});

test("truncateForContext says how much it dropped", () => {
    const out = truncateForContext("a".repeat(30), 10);
    assert.ok(out.startsWith("a".repeat(10)));
    assert.match(out, /truncated 20 characters/);
});

test("estimateTokens rounds up so nothing reads as zero", () => {
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(1), 1);
    assert.equal(estimateTokens(4), 1);
    assert.equal(estimateTokens(5), 2);
});

test("humanBytes switches unit at each threshold", () => {
    assert.equal(humanBytes(0), "0 B");
    assert.equal(humanBytes(1023), "1023 B");
    assert.equal(humanBytes(1024), "1 KB");
    assert.equal(humanBytes(1024 * 1024), "1.0 MB");
});

test("relativeTime buckets from minutes to an ISO date", () => {
    const now = Date.UTC(2026, 0, 20, 12, 0, 0);
    const ago = (ms: number) => relativeTime(new Date(now - ms), now);
    assert.equal(ago(10 * 1000), "just now");
    assert.equal(ago(5 * 60_000), "5m ago");
    assert.equal(ago(3 * 3600_000), "3h ago");
    assert.equal(ago(5 * 86400_000), "5d ago");
    assert.equal(ago(400 * 86400_000), "2024-12-16");
});

test("textOf joins text parts and ignores other content types", () => {
    assert.equal(textOf({ content: [
        { type: "text", text: "a" },
        { type: "image" },
        { type: "text", text: "b" },
    ] }), "ab");
});

test("textOf tolerates missing result and missing content", () => {
    assert.equal(textOf(undefined), "");
    assert.equal(textOf({}), "");
    assert.equal(textOf({ content: [{ type: "text" }] }), "");
});

test("finalAgentError exposes pi's terminal retry failure", () => {
    assert.equal(finalAgentError({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "Connection error.",
    }), "Connection error.");
});

test("finalAgentError ignores successful and non-terminal retry events", () => {
    assert.equal(finalAgentError({ type: "auto_retry_start", errorMessage: "Connection error." }), null);
    assert.equal(finalAgentError({ type: "auto_retry_end", success: true }), null);
    assert.equal(finalAgentError({ type: "agent_settled" }), null);
});

// -----------------------------------------------------------------------------
// Skills and prompt templates
// -----------------------------------------------------------------------------

import {
    commandDir, commandFile, commandInvocation, isPiCommand, normalizePiCommand,
    promptScaffold, skillScaffold, slugify, validateCommandName,
} from "../src/lib";

test("validateCommandName accepts pi's legal names", () => {
    for (const n of ["pdf-processing", "data-analysis", "a", "a1", "x".repeat(64)]) {
        assert.equal(validateCommandName(n), null, n);
    }
});

test("validateCommandName rejects what pi rejects", () => {
    for (const n of ["", "   ", "PDF-Processing", "-pdf", "pdf-", "pdf--processing",
                     "pdf processing", "pdf_processing", "pdf.md", "x".repeat(65)]) {
        assert.ok(validateCommandName(n), `${JSON.stringify(n)} should be rejected`);
    }
});

test("slugify produces a name validateCommandName accepts", () => {
    for (const raw of ["Review Staged Changes", "  PDF -- tools!! ", "C++ Build", "___"]) {
        const slug = slugify(raw);
        if (slug) assert.equal(validateCommandName(slug), null, `${raw} -> ${slug}`);
    }
    assert.equal(slugify("Review Staged Changes"), "review-staged-changes");
    assert.equal(slugify("___"), "");
});

test("slugify never exceeds the length limit or ends in a hyphen", () => {
    const slug = slugify("a ".repeat(80));
    assert.ok(slug.length <= 64);
    assert.ok(!slug.endsWith("-"));
    assert.equal(validateCommandName(slug), null);
});

test("commandDir matches the locations pi documents", () => {
    const home = "/home/u";
    const work = "/w/proj";
    assert.equal(commandDir("skill", "global", home, work), "/home/u/.pi/agent/skills");
    assert.equal(commandDir("prompt", "global", home, work), "/home/u/.pi/agent/prompts");
    assert.equal(commandDir("skill", "project", home, work), "/w/proj/.pi/skills");
    assert.equal(commandDir("prompt", "project", home, work), "/w/proj/.pi/prompts");
});

test("a skill is a directory with SKILL.md, a template is a flat file", () => {
    const home = "/home/u";
    const work = "/w/proj";
    assert.equal(commandFile("skill", "global", "pdf", home, work), "/home/u/.pi/agent/skills/pdf/SKILL.md");
    assert.equal(commandFile("prompt", "project", "review", home, work), "/w/proj/.pi/prompts/review.md");
});

test("commandInvocation prefixes skills but not templates", () => {
    assert.equal(commandInvocation("skill", "pdf"), "/skill:pdf");
    assert.equal(commandInvocation("prompt", "review"), "/review");
});

test("skillScaffold emits the required frontmatter fields", () => {
    const md = skillScaffold("pdf-tools", "Extracts text from PDFs. Use for PDF work.");
    assert.match(md, /^---\nname: pdf-tools\n/);
    assert.match(md, /\ndescription: .+\n---\n/);
});

test("scaffold frontmatter quotes descriptions that would break YAML", () => {
    for (const desc of ["a: b", "- leading dash", "#hash", 'has "quotes"', "line\nbreak"]) {
        const body = skillScaffold("x", desc).split("---")[1];
        const value = /description: (.*)/.exec(body)?.[1] ?? "";
        assert.doesNotMatch(value, /\n/, "must stay on one line");
        if (/^[-#]|: /.test(desc)) assert.ok(value.startsWith('"'), `${desc} must be quoted`);
    }
});

test("promptScaffold includes argument-hint only when given", () => {
    assert.doesNotMatch(promptScaffold("r", "Review", ""), /argument-hint/);
    assert.doesNotMatch(promptScaffold("r", "Review", "   "), /argument-hint/);
    assert.match(promptScaffold("r", "Review", "<PR-URL>"), /argument-hint: "<PR-URL>"/);
});

test("isPiCommand recognises what pi expands itself", () => {
    for (const m of ["/review", "/review staged", "/skill:pdf-tools", "/skill:pdf extract", "  /review"]) {
        assert.ok(isPiCommand(m), m);
    }
});

test("isPiCommand ignores prose that merely contains a slash", () => {
    for (const m of ["", "hello", "what does / do", "a/b", "//comment", "/ spaced", "/-bad"]) {
        assert.equal(isPiCommand(m), false, JSON.stringify(m));
    }
});

test("normalizePiCommand reads pi 0.84.4's nested sourceInfo", () => {
    // The RPC docs show flat path/location; the shipped build nests them.
    const c = normalizePiCommand({
        name: "skill:caveman", description: " Ultra-compressed. ", source: "skill",
        sourceInfo: { path: "/home/u/.agents/skills/caveman/SKILL.md", scope: "user" },
    });
    assert.equal(c.path, "/home/u/.agents/skills/caveman/SKILL.md");
    assert.equal(c.scope, "user");
    assert.equal(c.description, "Ultra-compressed.", "description is trimmed");
});

test("normalizePiCommand still reads the documented flat shape", () => {
    const c = normalizePiCommand({
        name: "fix-tests", source: "prompt", location: "project", path: "/p/.pi/prompts/fix-tests.md",
    });
    assert.equal(c.scope, "project");
    assert.equal(c.path, "/p/.pi/prompts/fix-tests.md");
});

test("normalizePiCommand tolerates a command with no origin at all", () => {
    const c = normalizePiCommand({ name: "x", source: "extension" });
    assert.equal(c.path, "");
    assert.equal(c.scope, "");
    assert.equal(c.description, "");
});

// -----------------------------------------------------------------------------
// Harness import
// -----------------------------------------------------------------------------

import {
    applyLinkSelection, harnessCandidates, linkedFrom, settingsPathFor, tildify, untildify,
} from "../src/lib";

test("harnessCandidates covers Claude and Codex, globally and per project", () => {
    const c = harnessCandidates("/home/u", "/w/proj");
    const dirs = c.map((s) => s.dir);
    for (const d of ["/home/u/.claude/skills", "/home/u/.claude/commands",
                     "/home/u/.codex/skills", "/home/u/.codex/prompts",
                     "/w/proj/.claude/skills", "/w/proj/.claude/commands"]) {
        assert.ok(dirs.includes(d), `missing ${d}`);
    }
});

test("harnessCandidates omits directories pi already scans natively", () => {
    // Linking these would be a no-op and would imply pi was not reading them.
    const dirs = harnessCandidates("/home/u", "/w/proj").map((s) => s.dir);
    for (const d of ["/home/u/.agents/skills", "/home/u/.pi/agent/skills",
                     "/home/u/.pi/agent/prompts", "/w/proj/.agents/skills"]) {
        assert.ok(!dirs.includes(d), `${d} should not be offered`);
    }
});

test("harnessCandidates maps commands to prompts and skills to skills", () => {
    const c = harnessCandidates("/home/u", "/w/proj");
    assert.equal(c.find((s) => s.dir === "/home/u/.claude/commands")?.kind, "prompts");
    assert.equal(c.find((s) => s.dir === "/home/u/.claude/skills")?.kind, "skills");
});

test("harnessCandidates gives every source a unique id", () => {
    const ids = harnessCandidates("/home/u", "/w/proj").map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
});

test("tildify and untildify round-trip a home-relative path", () => {
    assert.equal(tildify("/home/u/.claude/skills", "/home/u"), "~/.claude/skills");
    assert.equal(tildify("/home/u", "/home/u"), "~");
    assert.equal(tildify("/opt/skills", "/home/u"), "/opt/skills", "outside home stays absolute");
    assert.equal(untildify("~/.claude/skills", "/home/u"), "/home/u/.claude/skills");
    assert.equal(untildify("~", "/home/u"), "/home/u");
    assert.equal(untildify("/opt/x", "/home/u"), "/opt/x");
});

test("settingsPathFor matches pi's documented settings files", () => {
    assert.equal(settingsPathFor("global", "/home/u", "/w"), "/home/u/.pi/agent/settings.json");
    assert.equal(settingsPathFor("project", "/home/u", "/w"), "/w/.pi/settings.json");
});

test("applyLinkSelection adds a selected directory as a tilde path", () => {
    const out = applyLinkSelection([], ["/home/u/.claude/skills"], ["/home/u/.claude/skills"], "/home/u");
    assert.deepEqual(out, ["~/.claude/skills"]);
});

test("applyLinkSelection preserves entries the user added by hand", () => {
    const out = applyLinkSelection(
        ["/opt/my-own-skills", "~/.claude/skills"],
        ["/home/u/.claude/skills"], ["/home/u/.claude/skills"], "/home/u");
    assert.ok(out.includes("/opt/my-own-skills"), "hand-written entry must survive");
    assert.equal(out.filter((e) => e.includes(".claude/skills")).length, 1, "no duplicate");
});

test("applyLinkSelection removes only managed paths when deselected", () => {
    const out = applyLinkSelection(
        ["/opt/mine", "~/.claude/skills"], ["/home/u/.claude/skills"], [], "/home/u");
    assert.deepEqual(out, ["/opt/mine"]);
});

test("applyLinkSelection treats tilde, absolute and trailing-slash forms as one", () => {
    const out = applyLinkSelection(
        ["/home/u/.claude/skills/"], ["/home/u/.claude/skills"], ["/home/u/.claude/skills"], "/home/u");
    assert.equal(out.length, 1, "must not double-link the same directory");
});

test("linkedFrom reports which managed directories are already linked", () => {
    const managed = ["/home/u/.claude/skills", "/home/u/.codex/skills"];
    assert.deepEqual(linkedFrom(["~/.claude/skills"], managed, "/home/u"), ["/home/u/.claude/skills"]);
    assert.deepEqual(linkedFrom([], managed, "/home/u"), []);
});

// -----------------------------------------------------------------------------
// Session history
// -----------------------------------------------------------------------------

import { historyFromMessages, messageText, stripInjectedContext } from "../src/lib";

const PREAMBLE = "[IMPORTANT: After thinking, you MUST produce a clear, concise final answer. Never leave it empty.]";

test("messageText joins text blocks and ignores thinking and tool calls", () => {
    assert.equal(messageText({ role: "assistant", content: [
        { type: "thinking", text: "hmm" },
        { type: "text", text: "Hello " },
        { type: "toolCall", name: "bash" },
        { type: "text", text: "world" },
    ] } as never), "Hello world");
});

test("messageText handles a plain string and missing content", () => {
    assert.equal(messageText({ role: "user", content: "hi" }), "hi");
    assert.equal(messageText({ role: "user" }), "");
    assert.equal(messageText({ role: "user", content: null } as never), "");
});

test("historyFromMessages keeps only user and assistant prose", () => {
    // Real shape from a pi session: 44 messages, mostly toolResult.
    const out = historyFromMessages([
        { role: "user", content: [{ type: "text", text: "do a thing" }] },
        { role: "assistant", content: [{ type: "thinking", text: "..." }, { type: "toolCall" }] },
        { role: "toolResult", content: [{ type: "text", text: "total 160" }] },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ] as never, PREAMBLE);
    assert.deepEqual(out, [
        { role: "user", text: "do a thing" },
        { role: "assistant", text: "Done." },
    ]);
});

test("historyFromMessages strips the preamble the extension prepends", () => {
    const out = historyFromMessages(
        [{ role: "user", content: [{ type: "text", text: `${PREAMBLE}\n\nwhat changed?` }] }] as never,
        PREAMBLE);
    assert.deepEqual(out, [{ role: "user", text: "what changed?" }]);
});

test("historyFromMessages truncates a very long message", () => {
    const out = historyFromMessages(
        [{ role: "user", content: [{ type: "text", text: "x".repeat(9000) }] }] as never, "", 100);
    assert.ok(out[0].text.length < 200);
    assert.match(out[0].text, /truncated/);
});

test("historyFromMessages drops messages that are empty after stripping", () => {
    const out = historyFromMessages([
        { role: "user", content: [{ type: "text", text: PREAMBLE }] },
        { role: "assistant", content: [{ type: "text", text: "   " }] },
    ] as never, PREAMBLE);
    assert.deepEqual(out, []);
});

test("stripInjectedContext removes an old reasoning marker", () => {
    assert.equal(stripInjectedContext("[reasoning: high]\n\nfix it", ""), "fix it");
});

test("stripInjectedContext removes attached file sections", () => {
    const raw = `${PREAMBLE}\n\n--- src/a.ts ---\nconst a = 1;\nconst b = 2;\n\nexplain this`;
    assert.equal(stripInjectedContext(raw, PREAMBLE), "explain this");
});

test("stripInjectedContext leaves an ordinary prompt untouched", () => {
    assert.equal(stripInjectedContext("just a question", PREAMBLE), "just a question");
    assert.equal(stripInjectedContext("a --- b --- c", PREAMBLE), "a --- b --- c");
});
