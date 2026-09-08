import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/**
 * The renderer is plain browser JavaScript with no module system, so it is
 * loaded into a bare object standing in for `window`.
 */
interface Renderer { render(src: string): string; inline(src: string): string; esc(s: string): string }

const win: Record<string, unknown> = { MtwHighlight: null };
new Function("window", fs.readFileSync(
    path.join(__dirname, "..", "..", "media/webview/markdown.js"), "utf8"))(win);
const MD = win.MtwMarkdown as Renderer;

const lists = (html: string) => (html.match(/<ol|<ul/g) ?? []).length;

test("a tight ordered list is one list", () => {
    assert.equal(lists(MD.render("1. one\n2. two\n3. three")), 1);
});

test("a loose ordered list is still ONE list", () => {
    // Regression: a blank line ended the list, so every item opened a fresh
    // <ol> and rendered as "1." no matter its position.
    const html = MD.render("1. one\n\n2. two\n\n3. three");
    assert.equal(lists(html), 1, html);
    assert.equal((html.match(/<li>/g) ?? []).length, 3);
});

test("items all written as '1.' still number 1, 2, 3", () => {
    // Models emit this constantly; HTML must do the counting.
    const html = MD.render("1. **Role.** a\n\n1. **Who.** b\n\n1. **Yes.** c");
    assert.equal(lists(html), 1, html);
    assert.doesNotMatch(html, /start=/, "an all-ones list starts at 1");
});

test("an explicit start number is preserved", () => {
    assert.match(MD.render("3. three\n4. four"), /<ol start="3">/);
});

test("a loose list is marked so it can be spaced", () => {
    assert.match(MD.render("- a\n\n- b"), /<ul class="loose">/);
    assert.doesNotMatch(MD.render("- a\n- b"), /loose/);
});

test("a paragraph after a list ends the list", () => {
    const html = MD.render("1. one\n2. two\n\nA new paragraph.");
    assert.equal(lists(html), 1);
    assert.match(html, /<p>A new paragraph\.<\/p>/);
});

test("a nested loose list stays nested", () => {
    const html = MD.render("1. one\n\n   - sub a\n\n   - sub b\n\n2. two");
    assert.equal(lists(html), 2);
    assert.match(html, /<ol class="loose">/);
    assert.match(html, /<ul class="loose">/);
});

test("bullet and ordered runs do not merge into one list", () => {
    assert.equal(lists(MD.render("- a\n- b\n1. c\n2. d")), 2);
});

test("task list items keep their checkbox state", () => {
    const html = MD.render("- [x] done\n- [ ] todo");
    assert.match(html, /class="task checked"/);
    assert.match(html, /class="task"/);
});

test("markup in list text is escaped, not executed", () => {
    const html = MD.render("1. <img src=x onerror=alert(1)>");
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
});

test("an unterminated fence still renders as code", () => {
    // Streaming shows half a fence constantly; raw backticks must never flash.
    const html = MD.render("text\n\n```js\nconst a = 1;");
    assert.match(html, /<pre|<code/);
    assert.doesNotMatch(html, /```/);
});

test("render tolerates empty and whitespace input", () => {
    assert.equal(MD.render(""), "");
    assert.equal(typeof MD.render("\n\n  \n"), "string");
});
