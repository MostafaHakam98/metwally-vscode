/**
 * Qwen3.8-27B on a self-hosted vLLM server (A100 40GB).
 *
 * This used to hand-roll `streamSimple` with a curl subprocess. That build of
 * the request never forwarded pi's tool definitions and never parsed
 * `tool_calls` out of the response, so the model had no tools at all: asked
 * about a repo it could only guess, and would spiral into hallucination.
 *
 * The endpoint is a stock OpenAI-compatible vLLM server — it answers with
 * `finish_reason: "tool_calls"` and returns reasoning in the `reasoning`
 * field, both of which pi's built-in openai-completions transport already
 * handles. So we just describe the provider and let pi do the talking.
 */

const VLLM_URL = process.env.METWALLY_VLLM_URL || "http://localhost:8000/v1";
const API_KEY = process.env.METWALLY_VLLM_KEY || "dummy";

export default function (pi: any) {
	pi.registerProvider("qwen38-a100", {
		name: "Qwen3.8-27B (A100 40GB)",
		baseUrl: VLLM_URL,
		apiKey: API_KEY,
		api: "openai-completions",
		authHeader: true,
		models: [
			{
				id: "qwen3.8-27b",
				name: "Qwen3.8-27B (A100 40GB)",
				reasoning: true,
				input: ["text"],
				contextWindow: 229376,
				// Cap maxTokens to prevent the model from spending everything on reasoning
			maxTokens: 8192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: {
					// Verified against this server: it accepts reasoning_effort and
					// the developer role, and rejects nothing we send.
					supportsReasoningEffort: true,
					supportsDeveloperRole: true,
					supportsStore: false,
					maxTokensField: "max_tokens",
				},
			},
		],
	});
}
