# Metwally Coding Agent

A VS Code front-end for the `pi` coding agent, wired to a self-hosted model.

The extension speaks pi's line-delimited JSON RPC over stdio and renders the
agent's stream — text, reasoning, tool calls, diffs — in a webview that lives
either in the activity bar or as an editor tab.

---

## Layout

```
src/
  extension.ts      ChatController: pi process, event fan-out, commands
  rpc-client.ts     LF-framed JSON-RPC client over the pi child process
  webview-html.ts   loads media/webview/index.html, injects URIs + CSP nonce
media/
  icon.svg          activity-bar icon
  logo.svg          brand mark
  webview/
    index.html      shell + inline SVG sprite
    style.css       design system (tokens, components, responsive, a11y)
    main.js         app: streaming, composer, popovers, modals, persistence
    markdown.js     streaming-safe Markdown renderer
    highlight.js    dependency-free syntax highlighter
```

`media/webview/*.js` is served to the webview **verbatim** — it must stay plain
JavaScript. There is no bundler in this path, so TypeScript syntax in those
files is a hard runtime error (`SyntaxError`, whole UI dead).

## Build

```bash
npm install
npm run compile        # tsc -p ./
npm run watch          # incremental
npm run package        # .vsix via @vscode/vsce
```

`F5` in VS Code launches the Extension Development Host.

## Using it

| Surface | How |
|---|---|
| Sidebar chat | Activity-bar bolt icon, or `Ctrl+Alt+M` |
| Editor-tab chat | `Metwally: Open Chat in Editor` |
| Add selection | `Ctrl+Alt+I`, or right-click a selection |
| Stop generating | `Esc` in the chat, or `Ctrl+Alt+Esc` |
| New session | `Ctrl+L` in the chat |
| Logs | `Metwally: Show Logs` (Output channel) |

### In-chat

- `/` opens the command palette — `/new`, `/clear`, `/history`, `/model`,
  `/focus`, `/export`, `/settings`, `/help`, `/compact`, `/review`, `/tests`,
  `/explain`, `/fix`.
- `@` fuzzy-finds a workspace file and attaches it as context.
- Drag-and-drop or paste (images included) into the composer.
- Code blocks carry **copy**, **insert at cursor** and **open in new editor**.
- **Focus mode** hides reasoning and tool blocks, leaving only the prose.
- The ring on the model chip tracks context-window usage; the chip beside it
  shows session tokens and cost.

## Settings

All under `piVscode.*`:

| Key | Default | Purpose |
|---|---|---|
| `piPath` | `pi` | Absolute path wins; otherwise nvm / `/usr/local/bin` / `~/.local/bin` are probed |
| `provider` | `qwen38-a100` | Provider name passed to pi |
| `model` | `qwen3.8-27b` | Active model id |
| `modelLabel` | `Qwen3.8-27B` | Name shown in the header |
| `contextWindow` | `229000` | Drives the context-usage ring |
| `models` | `[]` | Entries for the in-chat model picker |
| `providerScript` | *(auto)* | pi extension loaded with `-e`, e.g. the vLLM provider |
| `noSession` | `false` | Disable on-disk session persistence |
| `requestTimeoutMs` | `600000` | Per-turn timeout |
| `showStatusBar` | `true` | Status-bar item with live cost |

Changing `model`, `provider`, `piPath`, `providerScript`, `noSession` or
`models` restarts the pi process; the open conversation is kept.

## Notes

- The webview CSP allows no remote origins. Everything — fonts, highlighting,
  Markdown — is local, and every script tag carries a per-render nonce.
- Colours derive from the active VS Code theme via `--vscode-*` variables, with
  a fixed brand accent. Light, dark and high-contrast themes are all handled,
  and `prefers-reduced-motion` disables the animations.
