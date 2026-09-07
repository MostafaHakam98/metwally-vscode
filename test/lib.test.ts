import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import {
    estimateTokens, expandPath, filePathFromArgs, humanBytes,
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
