/**
 * Minimal proxy for vLLM that strips the non-standard `reasoning` field
 * from streaming deltas, making it fully OpenAI-compatible for pi.
 *
 * Usage:
 *   node pi-config/proxy.js
 *   # Listens on :18021, forwards to vLLM on :18020
 */

const http = require("http");
const UPSTREAM = process.env.VLLM_URL || "http://localhost:18020";
const PORT = parseInt(process.env.PROXY_PORT || "18021", 10);

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("POST only");
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const isStreaming = JSON.parse(body).stream === true;

    const upstreamReq = http.request(
      `${UPSTREAM}${req.url}`,
      {
        method: "POST",
        headers: { ...req.headers, host: new URL(UPSTREAM).host, "content-length": Buffer.byteLength(body) },
      },
      (upstreamRes) => {
        if (isStreaming) {
          // Stream mode: pipe through, strip reasoning from deltas
          res.writeHead(upstreamRes.statusCode, {
            ...upstreamRes.headers,
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
          });

          let buffer = "";
          upstreamRes.on("data", (chunk) => {
            buffer += chunk.toString();

            // Process complete SSE events
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";

            for (const part of parts) {
              if (!part.trim()) continue;
              const lines = part.split("\n").map((l) => {
                if (l.startsWith("data: ") && l.slice(6) !== "[DONE]") {
                  try {
                    const obj = JSON.parse(l.slice(6));
                    const delta = obj.choices?.[0]?.delta;
                    if (delta && "reasoning" in delta) {
                      delete delta.reasoning;
                    }
                    return "data: " + JSON.stringify(obj);
                  } catch {
                    return l;
                  }
                }
                return l;
              });
              res.write(lines.join("\n") + "\n\n");
            }
          });

          upstreamRes.on("end", () => {
            if (buffer.trim()) {
              // Flush remaining
              const lines = buffer.split("\n").map((l) => {
                if (l.startsWith("data: ") && l.slice(6) !== "[DONE]") {
                  try {
                    const obj = JSON.parse(l.slice(6));
                    const delta = obj.choices?.[0]?.delta;
                    if (delta && "reasoning" in delta) delete delta.reasoning;
                    return "data: " + JSON.stringify(obj);
                  } catch { return l; }
                }
                return l;
              });
              res.write(lines.join("\n") + "\n\n");
            }
            res.end();
          });
        } else {
          // Non-streaming: buffer, strip reasoning, send
          let data = "";
          upstreamRes.on("data", (chunk) => (data += chunk));
          upstreamRes.on("end", () => {
            try {
              const obj = JSON.parse(data);
              const msg = obj.choices?.[0]?.message;
              if (msg && "reasoning" in msg) delete msg.reasoning;
              const json = JSON.stringify(obj);
              res.writeHead(upstreamRes.statusCode, {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(json),
              });
              res.end(json);
            } catch {
              res.writeHead(502);
              res.end("Bad upstream response");
            }
          });
        }
      }
    );

    upstreamReq.on("error", (err) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message } }));
    });

    upstreamReq.write(body);
    upstreamReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`[proxy] :${PORT} → ${UPSTREAM} (strips 'reasoning' field)`);
});
