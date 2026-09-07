## Connect your model

`pi` learns about a self-hosted model from an extension script loaded with `-e`.
Point `piVscode.providerScript` at yours:

```jsonc
"piVscode.providerScript": "/home/you/pi-vscode/pi-config/extensions/vllm-stream.ts",
"piVscode.provider": "qwen38-a100",
"piVscode.model": "qwen3.8-27b",
"piVscode.contextWindow": 229000
```

To offer several models in the in-chat picker, fill `piVscode.models` instead:

```jsonc
"piVscode.models": [
  { "id": "qwen3.8-27b", "label": "Qwen3.8-27B", "provider": "qwen38-a100", "contextWindow": 229000 },
  { "id": "llama-3-70b", "label": "Llama 3 70B", "provider": "local-llm",   "contextWindow": 128000 }
]
```

Secrets belong in `piVscode.env`, which is merged into the child process:

```jsonc
"piVscode.env": { "OPENAI_BASE_URL": "http://gpu-box:8000/v1" }
```
