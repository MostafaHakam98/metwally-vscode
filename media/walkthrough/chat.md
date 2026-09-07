## Open the chat

`Ctrl+Alt+M` (`Cmd+Alt+M`) focuses the sidebar. `Metwally: Open Chat in Editor`
opens the same session in a full editor tab — both views share one agent process.

In the composer:

- `/` lists slash commands — `/new`, `/history`, `/model`, `/compact`, `/export`.
- `@` searches workspace files to attach as context.
- The **Off / Low / Med / High** buttons set reasoning effort for the next turn.
  `piVscode.defaultEffort` sets where that starts.
- `Ctrl+Alt+Escape` stops a running turn.

Reasoning blocks are collapsed by default; `piVscode.showThinking` can expand or
hide them entirely.
