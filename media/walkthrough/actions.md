## Editor actions

Select code and right-click to reach **Metwally** — explain, fix, or write tests
for the selection. `Ctrl+Alt+A` opens the full action picker.

Add your own with `piVscode.customActions`:

```jsonc
"piVscode.customActions": [
  {
    "id": "docstring",
    "title": "Write a docstring",
    "prompt": "Write a docstring for this, matching the style used elsewhere in the file.",
    "autoSend": true,
    "includeSelection": true
  }
]
```

Reusing a built-in `id` (`explain`, `fix`, `test`, `review`) replaces it, so you
can retune the shipped prompts without forking the extension.
