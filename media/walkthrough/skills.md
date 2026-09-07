## Skills and prompt templates

Both are Markdown files that pi discovers at startup. Metwally can create them
for you — **Metwally: New Skill** or **New Prompt Template** — and writes them
where pi already looks.

| | Global | This project |
|---|---|---|
| Skills | `~/.pi/agent/skills/<name>/SKILL.md` | `.pi/skills/<name>/SKILL.md` |
| Prompt templates | `~/.pi/agent/prompts/<name>.md` | `.pi/prompts/<name>.md` |

**A prompt template** is a snippet that expands when you type `/name`. It takes
arguments as `$1`, `$@`, and `${1:-default}`:

```markdown
---
description: Review staged git changes
argument-hint: "[focus]"
---
Review `git diff --cached`, focusing on ${1:-correctness and error handling}.
```

**A skill** is a directory the agent loads on its own when the task matches its
`description`, or on demand with `/skill:name`. Only the description stays in
context; the body loads when it is needed.

Project files live under `.pi/` so they can be committed and shared — pi loads
them once the project is trusted.

`Ctrl+Alt+K` lists everything pi currently knows about, so you can insert, open
or delete it.
