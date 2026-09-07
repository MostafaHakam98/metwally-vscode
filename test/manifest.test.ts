import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/**
 * Wiring tests. Nothing here executes extension code — these catch the class of
 * bug that is invisible until a user clicks the thing: a command declared but
 * never registered, a webview message nobody handles, an icon that renders
 * blank, or a setting enum that does not match the UI it drives.
 */

const ROOT = path.join(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const pkg = JSON.parse(read("package.json"));
const extSrc = read("src/extension.ts");
const webviewJs = read("media/webview/main.js");
const webviewHtml = read("media/webview/index.html");
const webviewCss = read("media/webview/style.css");

const all = (re: RegExp, s: string) => [...s.matchAll(re)].map((m) => m[1]);
const uniq = (xs: string[]) => [...new Set(xs)];

const declaredCommands = new Set<string>(pkg.contributes.commands.map((c: { command: string }) => c.command));
const registeredCommands = new Set(all(/reg\("([A-Za-z]+)"/g, extSrc).map((id) => `piVscode.${id}`));

test("every declared command is registered at activation", () => {
    assert.deepEqual([...declaredCommands].filter((c) => !registeredCommands.has(c)), []);
});

test("every registered command is declared in the manifest", () => {
    // An undeclared command cannot appear in the palette or a menu.
    assert.deepEqual([...registeredCommands].filter((c) => !declaredCommands.has(c)), []);
});

test("every menu and keybinding references a declared command", () => {
    const refs = uniq([
        ...Object.values(pkg.contributes.menus as Record<string, Array<{ command?: string }>>)
            .flat().map((i) => i.command).filter(Boolean) as string[],
        ...(pkg.contributes.keybindings as Array<{ command: string }>).map((k) => k.command),
    ]);
    assert.deepEqual(refs.filter((c) => !declaredCommands.has(c)), []);
});

test("every submenu used in a menu is defined and has its own block", () => {
    const defined = new Set((pkg.contributes.submenus ?? []).map((s: { id: string }) => s.id));
    const used = uniq(Object.values(pkg.contributes.menus as Record<string, Array<{ submenu?: string }>>)
        .flat().map((i) => i.submenu).filter(Boolean) as string[]);
    assert.deepEqual(used.filter((id) => !defined.has(id)), [], "undefined submenu");
    assert.deepEqual([...defined].filter((id) => !pkg.contributes.menus[id as string]), [], "submenu with no items");
});

test("every message the webview posts is handled by the extension", () => {
    const posted = uniq(all(/post\("([a-z-]+)"/g, webviewJs));
    const handled = new Set(all(/case "([a-z-]+)":/g, extSrc));
    assert.deepEqual(posted.filter((m) => !handled.has(m)), []);
});

test("every icon the webview draws exists in the sprite", () => {
    const sprite = new Set(all(/id="(i-[a-z-]+)"/g, webviewHtml));
    const used = uniq([
        ...all(/svg\("(i-[a-z-]+)"/g, webviewJs),
        ...all(/icon:\s*"(i-[a-z-]+)"/g, webviewJs),
        ...all(/href="#(i-[a-z-]+)"/g, webviewHtml),
    ]);
    assert.deepEqual(used.filter((i) => !sprite.has(i)), []);
});

test("every element id the webview script looks up exists in the HTML", () => {
    const ids = new Set(all(/id="([a-z-]+)"/g, webviewHtml));
    assert.deepEqual(uniq(all(/\$\("([a-z-]+)"\)/g, webviewJs)).filter((i) => !ids.has(i)), []);
});

test("defaultEffort enum matches the effort buttons it drives", () => {
    // Regression: the enum shipped "med" while the button is "medium", so
    // setting it deselected every button.
    const buttons = all(/data-v="([a-z]+)"/g, webviewHtml).sort();
    const enumVals = [...pkg.contributes.configuration.properties["piVscode.defaultEffort"].enum].sort();
    assert.deepEqual(enumVals, buttons);
});

test("defaultEffort levels are all accepted by pi's set_thinking_level", () => {
    const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const v of pkg.contributes.configuration.properties["piVscode.defaultEffort"].enum) {
        assert.ok(PI_LEVELS.includes(v), `${v} is not a pi thinking level`);
    }
});

test("every enum setting has one description per value", () => {
    for (const [key, spec] of Object.entries<Record<string, unknown>>(pkg.contributes.configuration.properties)) {
        const e = spec.enum as string[] | undefined;
        const d = spec.enumDescriptions as string[] | undefined;
        if (e && d) assert.equal(d.length, e.length, key);
    }
});

test("every setting cross-referenced with #...# resolves", () => {
    const props = pkg.contributes.configuration.properties;
    for (const [key, spec] of Object.entries<Record<string, unknown>>(props)) {
        for (const ref of all(/#(piVscode\.[A-Za-z.]+)#/g, String(spec.markdownDescription ?? ""))) {
            assert.ok(ref in props, `${key} links to unknown setting ${ref}`);
        }
    }
});

test("every setting is namespaced and documented", () => {
    for (const [key, spec] of Object.entries<Record<string, unknown>>(pkg.contributes.configuration.properties)) {
        assert.ok(key.startsWith("piVscode."), key);
        assert.ok(spec.description || spec.markdownDescription, `${key} has no description`);
        assert.ok("default" in spec, `${key} has no default`);
    }
});

test("settings that change the pi command line force a respawn", () => {
    // A spawn-time argument that only refreshed the view would silently keep
    // running the old process.
    const respawn = extSrc.slice(extSrc.indexOf("const RESPAWN_KEYS"), extSrc.indexOf("const MODEL_KEYS"));
    for (const key of ["piPath", "providerScript", "noSession", "sessionDir", "env", "extraArgs", "workingDirectory"]) {
        assert.ok(respawn.includes(`"${key}"`), `${key} missing from RESPAWN_KEYS`);
    }
});

test("every walkthrough step points at a file that exists", () => {
    for (const w of pkg.contributes.walkthroughs ?? []) {
        for (const step of w.steps) {
            const f = step.media.markdown;
            assert.ok(fs.existsSync(path.join(ROOT, f)), `missing ${f}`);
        }
    }
});

test("the activity-bar icon and every menu icon asset exists", () => {
    const assets = uniq([
        pkg.contributes.viewsContainers.activitybar[0].icon,
        ...(pkg.contributes.submenus ?? []).map((s: { icon?: string }) => s.icon).filter(Boolean),
    ]) as string[];
    for (const a of assets) assert.ok(fs.existsSync(path.join(ROOT, a)), `missing ${a}`);
});

test("the sidebar view is a webview, so viewsWelcome would never render", () => {
    // contributes.viewsWelcome only applies to tree views. The empty state is
    // drawn inside the webview instead; declaring it here would be dead config.
    assert.equal(pkg.contributes.views.metwally[0].type, "webview");
    assert.equal(pkg.contributes.viewsWelcome, undefined);
});

test("webview scripts stay plain JavaScript", () => {
    // media/webview/*.js is served verbatim with no bundler; TypeScript syntax
    // there is a SyntaxError that kills the whole UI.
    for (const f of ["main.js", "markdown.js", "highlight.js"]) {
        const src = read(path.join("media/webview", f));
        assert.doesNotMatch(src, /^\s*(interface|type)\s+\w+\s*[={]/m, `${f} has TS syntax`);
        assert.doesNotMatch(src, /^\s*import\s+.*\sfrom\s+["']/m, `${f} has ESM imports`);
    }
});

test("the webview CSP allows no remote origins", () => {
    const csp = /content="([^"]*)"/.exec(
        /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(webviewHtml)?.[0] ?? "")?.[1] ?? "";
    assert.ok(csp.includes("default-src 'none'"), "CSP must default to none");
    assert.doesNotMatch(csp, /https?:/, "no remote origin may be allowed");
    assert.ok(csp.includes("'nonce-{{nonce}}'"), "scripts must be nonce-gated");
});

test("every CSS class the webview emits is styled", () => {
    const emitted = uniq(all(/class="([a-z][a-z0-9 -]*)"/g, webviewJs))
        .flatMap((c) => c.split(/\s+/))
        // State classes toggled by script, plus "ut" which is a selector hook for
        // setting user text via textContent rather than innerHTML.
        .filter((c) => c && !["on", "sel", "live", "open", "err", "ok", "stop", "ut"].includes(c));
    const missing = emitted.filter((c) => !webviewCss.includes(`.${c}`));
    assert.deepEqual(missing, []);
});

test("the manifest declares that untrusted workspaces are unsupported", () => {
    // The agent runs shell commands in the open folder.
    assert.equal(pkg.capabilities.untrustedWorkspaces.supported, false);
});

test("the packaged extension excludes sources and config", () => {
    const ignore = read(".vscodeignore");
    for (const rule of ["src/**", "node_modules/**", "**/*.ts"]) {
        assert.ok(ignore.includes(rule), `.vscodeignore missing ${rule}`);
    }
});
