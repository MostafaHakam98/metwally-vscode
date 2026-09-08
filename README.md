# Metwally Coding Agent

A VS Code front-end for the `pi` coding agent, built for self-hosted models.

- **Any OpenAI-compatible server** — vLLM, Ollama, llama.cpp, LM Studio, LiteLLM.
  Point it at a URL; no hosted API account required.
- **Zero-dependency webview** — its own streaming Markdown renderer and syntax
  highlighter, no bundler, no npm UI stack.
- **Full agent stream** — text, reasoning, tool calls and diffs, rendered live
  over pi's line-delimited JSON RPC.

The extension speaks pi's line-delimited JSON RPC over stdio and renders the
agent's stream in a webview that lives either in the activity bar or as an
editor tab.

---

## Layout

```
src/
  extension.ts      ChatSession + SessionManager: pi processes, events, commands
  lib.ts            pure helpers, no vscode import — the unit-tested core
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
npm test               # node:test, no extra dependencies
npm run package        # .vsix via @vscode/vsce
```

Tests live in `test/` and run on the plain Node test runner:

- `lib.test.ts` covers the pure helpers in `src/lib.ts` (path expansion, diff
  line counts, tab titling, truncation, formatting).
- `rpc-client.test.ts` drives the LF framing directly — split chunks, CRLF,
  blank lines, malformed JSON, multi-byte characters split mid-codepoint,
  request/response correlation.
- `manifest.test.ts` checks wiring that fails silently at runtime: commands
  declared but never registered, menu entries pointing at nothing, webview
  messages nobody handles, missing sprite icons or element ids, setting enums
  that disagree with the UI they drive, and TypeScript syntax leaking into
  `media/webview/*.js`.

`F5` in VS Code launches the Extension Development Host.

## Using it

| Surface | How |
|---|---|
| Sidebar chat | Activity-bar bolt icon, or `Ctrl+Alt+M` |
| New chat tab | `Ctrl+Alt+N`, or `Metwally: New Chat Tab` |
| Switch session | Click the status bar, or `Metwally: Switch Session...` |
| Add selection | `Ctrl+Alt+I`, or right-click a selection |
| Run an action | `Ctrl+Alt+A`, or right-click -> **Metwally** |
| Skills and commands | `Ctrl+Alt+K` |
| Add a file | Right-click it in the Explorer -> **Add File to Chat** |
| Explain terminal output | Select it, right-click in the terminal |
| Commit message | The sparkle icon in the Source Control title bar |
| Stop generating | `Esc` in the chat, or `Ctrl+Alt+Esc` |
| New session | `Ctrl+L` in the chat |
| Restart the agent | `Metwally: Restart Agent` |
| Logs | `Metwally: Show Logs` (Output channel) |
| First-run guide | `Welcome: Open Walkthrough` -> **Set up Metwally Coding Agent** |

### Sessions

Every editor tab is an **independent session** with its own `pi` process,
conversation, cost and context ring. Split them side by side to watch two agents
work at once. The sidebar holds one further session that survives being
collapsed.

- `Ctrl+Alt+N` opens a new tab. `piVscode.maxSessions` (default `4`) caps how
  many, because concurrent turns contend for one model server.
- Tabs are named after their first prompt.
- `/history` reopens a previous session: pi rebinds to the session file and the
  transcript is replayed from `get_messages`. Only the prose comes back —
  reasoning and tool output are not re-rendered — and a switch takes a few
  seconds, so a progress note is shown while it runs.
- **Open Current Session in Editor** mirrors the sidebar conversation into a
  tab; both views stay in sync and closing the mirror leaves the session alive.
- Closing a tab kills that session's `pi` process.
- Editor commands (`Ctrl+Alt+I`, actions, commit message) act on the **last
  focused** session, falling back to the sidebar.
- The status bar shows the session count and the focused session's cost; the
  spinner appears while any session is working.

`model`, `provider` and `workingDirectory` are global, so changing one respawns
every open session. Sessions do not survive a window reload — the tabs close.

### Context

The composer owns three context affordances:

| Control | What it does |
|---|---|
| **+** | Adds workspace context: active file, selection, open editors, `git diff HEAD`, workspace problems, terminal selection |
| **pin** on a file chip | Promotes a one-shot attachment to a pin |
| **scan** icon, or `/context` | Opens the inspector |

**Pins vs attachments.** An attachment is read once, when you send. A pin is
re-read on *every* turn, so edits since the last prompt are picked up — the right
choice for the file you are actively working on. Pins survive `/new`; they are a
working set, not conversation state. `piVscode.pinnedContext` pins files for
every session permanently.

**The inspector** (`/context`) lists everything that will be prepended to your
next prompt — auto-context files, settings pins, session pins, the active file —
with per-item token estimates and a meter against the model's context window.
Estimates assume ~4 characters per token.

### Skills and prompt templates

Both are Markdown files pi discovers at startup. Create them from the extension
— **New Skill** / **New Prompt Template**, or `/new-skill` and `/new-prompt` in
the chat — and it writes them where pi already looks:

| | Global | This project |
|---|---|---|
| Skills | `~/.pi/agent/skills/<name>/SKILL.md` | `.pi/skills/<name>/SKILL.md` |
| Prompt templates | `~/.pi/agent/prompts/<name>.md` | `.pi/prompts/<name>.md` |

A **prompt template** expands when you type `/name`, with `$1`, `$@` and
`${1:-default}` arguments. A **skill** is a directory the agent loads on its own
when the task matches its `description`, or on demand via `/skill:name`.

`Ctrl+Alt+K` lists everything pi currently knows about — extension commands,
templates and skills — to insert, open or delete. The same list is merged into
the composer's `/` menu, so your own commands autocomplete alongside the
built-in ones. pi expands them itself, so Metwally sends the message untouched.

**Project resources need `piVscode.trustProject`.** pi never asks about trust in
RPC mode, so without `--approve` it silently ignores everything under a
project's `.pi/`. Turning the setting on passes that flag — which also lets pi
load project settings and run project-local extensions, so enable it only for
repositories you trust. The New Skill flow offers to enable it rather than
writing a file pi would ignore.

Skills and templates are scanned when pi starts, so the extension offers to
restart the agent after creating one.

### Reviewing what the agent changed

When a tool edits a file, the extension snapshots it first, then shows a bar
above the composer: `3 files changed`, each chip carrying approximate `+/-`
counts. Click a chip for a real diff against the pre-edit content, or the undo
arrow to restore it. `piVscode.reviewEdits` turns this off.

Only tools that name a file in their arguments are tracked. Changes made by a
shell command are invisible to this — the extension cannot know which files a
`bash` call touched.

### Steering a running turn

Type while the agent is working and the send button becomes **steer**: the
message is delivered by pi after the current tool calls finish, before the next
model call, instead of queueing a whole new prompt. `Esc` still aborts.

### In-chat

- `/` opens the command palette — `/new`, `/clear`, `/history`, `/model`,
  `/focus`, `/export`, `/settings`, `/help`, `/context`, `/pins`, `/compact`,
  `/skills`, `/new-skill`, `/new-prompt`, `/review`, `/tests`, `/explain`,
  `/fix` — plus every prompt template, skill and extension command pi reports.
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
| `startupTimeoutMs` | `30000` | Timeout for `new_session` / `switch_session` |
| `showStatusBar` | `true` | Show the status-bar item |
| `statusBar.showCost` | `true` | Include the running cost in it |

### Process

| Key | Default | Purpose |
|---|---|---|
| `workingDirectory` | *(first folder)* | Agent cwd. Supports `~` and `${workspaceFolder}` |
| `env` | `{}` | Environment for the pi process, merged over the inherited one |
| `extraArgs` | `[]` | Extra CLI arguments, appended after `--provider`/`--model` |
| `sessionDir` | *(pi default)* | Passed as `--session-dir` |
| `sessionsRoot` | `~/.pi/agent/sessions` | Scanned to build `/history` |
| `sessionHistoryLimit` | `25` | Entries in the history picker |

### Prompting

| Key | Default | Purpose |
|---|---|---|
| `promptPreamble` | *(answer-nudge)* | Prepended to every prompt; empty disables it |
| `defaultEffort` | `high` | Reasoning effort a fresh view starts on |
| `autoContextFiles` | `AGENTS.md`, `CLAUDE.md`, `CONVENTIONS.md` | Sent once per session if present |
| `attachActiveFile` | `false` | Attach the active editor to every prompt |
| `maxAttachmentBytes` | `120000` | Per-file truncation limit |
| `fileSearchExclude` | *(build dirs)* | Glob excluded from the `@` picker |
| `pinnedContext` | `[]` | Files pinned into every prompt of every session |
| `trustProject` | `false` | Pass `--approve` so pi loads this project's `.pi/` resources |
| `customActions` | `[]` | Extra entries for **Run Action...** |

### View

| Key | Default | Purpose |
|---|---|---|
| `reviewEdits` | `true` | Offer a diff and revert for files a tool changed |
| `showThinking` | `collapsed` | `always` \| `collapsed` \| `hidden` |
| `confirmNewSession` | `true` | Confirm before discarding a transcript |
| `maxSessions` | `4` | Maximum chat tabs; the sidebar does not count |

Changing `model`, `provider`, `piPath`, `providerScript`, `noSession`, `models`,
`sessionDir`, `env`, `extraArgs` or `workingDirectory` restarts the pi process;
the open conversation is kept. Everything else applies without a restart.

### Custom actions

`customActions` entries reuse the same code path as the built-ins, so reusing an
id (`explain`, `fix`, `test`, `review`) overrides the shipped prompt:

```jsonc
"piVscode.customActions": [
  {
    "id": "docstring",
    "title": "Write a docstring",
    "prompt": "Write a docstring for this, matching the style used elsewhere in the file.",
    "autoSend": true,
    "includeSelection": true,
    "includeDiagnostics": false
  }
]
```

## Notes

- The webview CSP allows no remote origins. Everything — fonts, highlighting,
  Markdown — is local, and every script tag carries a per-render nonce.
- Colours derive from the active VS Code theme via `--vscode-*` variables, with
  a fixed brand accent. Light, dark and high-contrast themes are all handled,
  and `prefers-reduced-motion` disables the animations.
