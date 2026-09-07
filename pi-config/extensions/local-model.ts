/**
 * Pi custom provider extension for self-hosted LLMs
 *
 * Supports OpenAI-compatible APIs:
 *   - Ollama:        http://localhost:11434/v1
 *   - vLLM:          http://localhost:8000/v1
 *   - llama.cpp:     http://localhost:8080/v1
 *   - LM Studio:     http://localhost:1234/v1
 *   - LiteLLM proxy: http://localhost:4000/v1
 *
 * Usage:
 *   pi --mode rpc -e ./pi-config/extensions/local-model.ts
 *   # or set up via models.json (see below)
 *
 * Configuration via environment variables:
 *   PI_LOCAL_BASE_URL  - Base URL (default: http://localhost:11434/v1)
 *   PI_LOCAL_API_KEY   - API key (default: "ollama" for Ollama)
 *   PI_LOCAL_MODEL     - Model ID (default: llama-3-70b)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Read config from environment
const BASE_URL = process.env.PI_LOCAL_BASE_URL || "http://localhost:11434/v1";
const API_KEY = process.env.PI_LOCAL_API_KEY || "ollama";
const MODEL_ID = process.env.PI_LOCAL_MODEL || "llama-3-70b";
const MODEL_NAME = process.env.PI_LOCAL_MODEL_NAME || MODEL_ID;
const CONTEXT_WINDOW = parseInt(process.env.PI_LOCAL_CONTEXT_WINDOW || "128000", 10);
const MAX_TOKENS = parseInt(process.env.PI_LOCAL_MAX_TOKENS || "4096", 10);
const REASONING = process.env.PI_LOCAL_REASONING === "true";
const PROVIDER_ID = process.env.PI_LOCAL_PROVIDER_ID || "local-llm";

export default function (pi: ExtensionAPI) {
    pi.registerProvider(PROVIDER_ID, {
        name: "Local LLM (Self-Hosted)",
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        api: "openai-completions",
        authHeader: true, // sends Authorization: Bearer <key>

        models: [
            {
                id: MODEL_ID,
                name: MODEL_NAME,
                reasoning: REASONING,
                input: ["text"], // add "image" if your model supports it
                cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                },
                contextWindow: CONTEXT_WINDOW,
                maxTokens: MAX_TOKENS,
            },
        ],
    });

    console.error(
        `[pi-vscode] Registered provider "${PROVIDER_ID}" → ${BASE_URL} (${MODEL_ID})`,
    );
}
