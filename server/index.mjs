import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PORT = Number(process.env.PORT ?? 5173);
const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Pollinations "Classic" API. No key, no signup, rate limited per IP.
 * https://text.pollinations.ai/openai is OpenAI-compatible.
 */
const POLLINATIONS_BASE =
  process.env.POLLINATIONS_BASE_URL ?? "https://text.pollinations.ai/openai";
const POLLINATIONS_MODELS =
  process.env.POLLINATIONS_MODELS_URL ?? "https://text.pollinations.ai/models";

const DEFAULT_MODEL = "openai-fast";

/**
 * Curated catalog. The live /models endpoint only advertises the models that
 * are free for anonymous (keyless) callers today; the rest of the catalog is
 * kept so the switcher has some range, but they are flagged as possibly
 * needing a key. Availability shown in the UI comes from the live probe.
 */
const CURATED = [
  {
    id: "openai-fast",
    name: "GPT-OSS 20B",
    vendor: "OpenAI · OVH",
    blurb: "Fast, keyless, handles reasoning. The default free model.",
    tier: "free",
    tags: ["reasoning", "fast"],
  },
  {
    id: "openai",
    name: "OpenAI (alias)",
    vendor: "OpenAI",
    blurb: "Alias that resolves to the fastest available OpenAI model.",
    tier: "free",
    tags: ["fast"],
  },
  {
    id: "openai-large",
    name: "GPT-4.1 class",
    vendor: "OpenAI",
    blurb: "Larger OpenAI model. May require a Pollinations API key.",
    tier: "key",
    tags: ["large"],
  },
  {
    id: "openai-reasoning",
    name: "o-series reasoner",
    vendor: "OpenAI",
    blurb: "Longer chains of thought for hard problems. Key may be required.",
    tier: "key",
    tags: ["reasoning"],
  },
  {
    id: "mistral",
    name: "Mistral Small",
    vendor: "Mistral AI",
    blurb: "Snappy European model, good at concise answers.",
    tier: "key",
    tags: ["concise"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    vendor: "DeepSeek",
    blurb: "Strong at code and math. May require a key.",
    tier: "key",
    tags: ["code", "math"],
  },
  {
    id: "gemini",
    name: "Gemini Flash",
    vendor: "Google",
    blurb: "Very fast multimodal-family model. May require a key.",
    tier: "key",
    tags: ["fast"],
  },
  {
    id: "claude",
    name: "Claude",
    vendor: "Anthropic",
    blurb: "Thoughtful long-form writing. Paid tiers only.",
    tier: "key",
    tags: ["writing"],
  },
  {
    id: "gemini-search",
    name: "Gemini (search)",
    vendor: "Google",
    blurb: "Answers grounded with a live web search. May require a key.",
    tier: "key",
    tags: ["search"],
  },
  {
    id: "nova-fast",
    name: "Nova Lite",
    vendor: "Amazon",
    blurb: "Low latency general purpose model. May require a key.",
    tier: "key",
    tags: ["fast"],
  },
];

function titleCase(id) {
  return id
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Build the switcher list, using the live endpoint as the source of truth. */
async function buildModelList() {
  let live = null;
  try {
    const res = await fetch(POLLINATIONS_MODELS, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) live = data;
    }
  } catch {
    /* offline or blocked — fall back to the curated catalog below */
  }

  const byId = new Map(CURATED.map((m) => [m.id, { ...m }]));
  const liveIds = new Set();

  if (live) {
    for (const entry of live) {
      const ids = [entry.name, ...(entry.aliases ?? [])].filter(Boolean);
      if (entry.output_modalities && !entry.output_modalities.includes("text")) {
        continue;
      }
      const primary = entry.name;
      liveIds.add(primary);
      const existing = byId.get(primary);
      if (existing) {
        existing.blurb = existing.blurb || entry.description;
        existing.tier = entry.tier === "anonymous" ? "free" : existing.tier;
        existing.available = entry.tier === "anonymous";
      } else {
        byId.set(primary, {
          id: primary,
          name: entry.description?.split("(")[0]?.trim() || titleCase(primary),
          vendor: "Pollinations",
          blurb: entry.description ?? "Live model advertised by Pollinations.",
          tier: entry.tier === "anonymous" ? "free" : "key",
          tags: entry.reasoning ? ["reasoning"] : [],
          available: entry.tier === "anonymous",
        });
      }
      for (const alias of ids) {
        if (alias !== primary && !byId.has(alias)) {
          byId.set(alias, {
            id: alias,
            name: `${titleCase(alias)}`,
            vendor: "Pollinations",
            blurb: `Alias for ${primary}.`,
            tier: entry.tier === "anonymous" ? "free" : "key",
            tags: ["alias"],
            available: entry.tier === "anonymous",
          });
        }
      }
    }
  }

  const models = [...byId.values()].map((m) => ({
    ...m,
    available:
      typeof m.available === "boolean"
        ? m.available
        : live
          ? false
          : m.tier === "free",
    listed: liveIds.has(m.id) || !live,
  }));

  // Free models first, then keyed ones; keep the default pinned on top.
  models.sort((a, b) => {
    if (a.id === DEFAULT_MODEL) return -1;
    if (b.id === DEFAULT_MODEL) return 1;
    if (a.tier !== b.tier) return a.tier === "free" ? -1 : 1;
    if (a.available !== b.available) return a.available ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { models, source: live ? "live" : "fallback", defaultModel: DEFAULT_MODEL };
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.disable("x-powered-by");

// Very light per-IP throttle. Pollinations already rate limits us, this just
// stops the UI from stacking requests it knows will be rejected.
const RETRY_CAP_MS = Number(process.env.RETRY_CAP_MS ?? 6000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lastRequest = new Map();
const MIN_GAP_MS = Number(process.env.MIN_REQUEST_GAP_MS ?? 1200);

function throttled(ip) {
  const now = Date.now();
  const prev = lastRequest.get(ip) ?? 0;
  if (now - prev < MIN_GAP_MS) return MIN_GAP_MS - (now - prev);
  lastRequest.set(ip, now);
  return 0;
}

app.get("/api/models", async (_req, res) => {
  const payload = await buildModelList();
  res.set("cache-control", "public, max-age=120");
  res.json(payload);
});

const diagLog = [];

/**
 * The browser reports what it saw when a request fails. This is the only way
 * to observe failures that happen outside the server process (CORS, a user's
 * content blocker, a direct-to-Pollinations rejection).
 */
app.post("/api/log", (req, res) => {
  const entry = { at: new Date().toISOString(), ip: req.ip, ...(req.body ?? {}) };
  diagLog.push(entry);
  if (diagLog.length > 100) diagLog.shift();
  console.warn(`[client-diag] ${JSON.stringify(entry)}`);
  res.status(204).end();
});

app.get("/api/diag", (_req, res) => {
  res.json(diagLog.slice(-50).reverse());
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, upstream: POLLINATIONS_BASE });
});

app.post("/api/chat", async (req, res) => {
  const { model, messages, temperature, stream = true } = req.body ?? {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages[] is required" });
  }

  const clean = messages
    .filter((m) => m && typeof m.content === "string" && m.content.trim())
    .slice(-40)
    .map((m) => ({
      role: ["system", "user", "assistant"].includes(m.role) ? m.role : "user",
      content: m.content.slice(0, 12000),
    }));

  const wait = throttled(req.ip ?? "anon");
  if (wait > 0) {
    return res.status(429).json({
      error: "Slow down a moment — Pollinations allows about one request every 30 seconds per IP.",
      retryInMs: wait,
    });
  }

  const upstreamBody = {
    model: typeof model === "string" && model ? model : DEFAULT_MODEL,
    messages: clean,
    stream: Boolean(stream),
    referrer: "https://github.com/PythonEaterBoi/open-source-chatbot-v2",
  };
  if (typeof temperature === "number") {
    upstreamBody.temperature = Math.min(2, Math.max(0, temperature));
  }

  // The anonymous tier allows roughly one request per IP every 30s, so a
  // second turn can trip a 429. Retry briefly before surfacing the error.
  const MAX_ATTEMPTS = 3;
  let upstream;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      upstream = await fetch(POLLINATIONS_BASE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: stream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      lastErr = err;
      upstream = undefined;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(600 * attempt * attempt);
        continue;
      }
      break;
    }

    if (upstream.ok) break;
    if (upstream.status !== 429 && upstream.status < 500) break;
    if (attempt === MAX_ATTEMPTS) break;

    const retryAfter = Number(upstream.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, RETRY_CAP_MS)
      : 700 * attempt * attempt;
    await upstream.body?.cancel?.().catch(() => {});
    await sleep(waitMs);
  }

  if (!upstream) {
    const cause =
      lastErr?.cause?.code ?? lastErr?.cause?.message ?? lastErr?.name ?? "unknown";
    console.warn(
      `[upstream] could not reach ${POLLINATIONS_BASE}: ${lastErr?.message} (cause=${cause})`,
    );
    // The server itself has no route to Pollinations (common on locked-down
    // or sandboxed networks). Tell the client to retry from the browser,
    // which may well have internet access.
    return res.status(502).json({
      code: "upstream_unreachable",
      error: `Could not reach Pollinations: ${lastErr?.message ?? "network error"}`,
    });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    const hint =
      upstream.status === 402 || upstream.status === 401
        ? "This model needs a Pollinations API key or Pollen credits. Try the free GPT-OSS 20B model."
        : upstream.status === 429
          ? "Pollinations is rate limiting this IP (the free tier allows about one request every 30 seconds). Wait a moment, then send again."
          : "Upstream error.";
    return res.status(upstream.status === 429 ? 429 : 502).json({
      error: `${hint} (HTTP ${upstream.status})`,
      detail: detail.slice(0, 600),
    });
  }

  const contentType = upstream.headers.get("content-type") ?? "";

  // Non-streaming upstream (or client didn't ask for a stream).
  if (!stream || !contentType.includes("text/event-stream")) {
    const text = await upstream.text();
    let content = "";
    let reasoning = "";
    try {
      const json = JSON.parse(text);
      content =
        json?.choices?.[0]?.message?.content ??
        json?.choices?.[0]?.text ??
        json?.text ??
        "";
      reasoning = json?.choices?.[0]?.message?.reasoning_content ?? "";
    } catch {
      content = text; // plain-text response
    }
    return res.json({ content, reasoning, model: upstreamBody.model });
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  // Abort upstream work if the browser goes away.
  req.on("close", () => {
    finished = true;
    upstream.body?.cancel?.().catch(() => {});
  });

  try {
    for await (const chunk of upstream.body) {
      if (finished) break;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = parsed?.choices?.[0]?.delta ?? {};
        if (delta.reasoning_content) {
          send({ type: "reasoning", text: delta.reasoning_content });
        }
        if (delta.content) {
          send({ type: "delta", text: delta.content });
        }
        if (parsed?.choices?.[0]?.finish_reason) {
          send({ type: "done", finishReason: parsed.choices[0].finish_reason });
        }
      }
    }
    if (!finished) send({ type: "done" });
  } catch (err) {
    if (!finished) {
      send({ type: "error", error: err?.message ?? "Stream interrupted" });
    }
  } finally {
    res.end();
  }
});

// ---- frontend: Vite middleware in dev, static files in prod ----------------
if (IS_PROD) {
  const dist = path.join(ROOT, "dist");
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: ROOT,
    server: { middlewareMode: true, hmr: { server: undefined } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Chat server ready → http://0.0.0.0:${PORT} (${IS_PROD ? "production" : "dev"})`);
  console.log(`Upstream: ${POLLINATIONS_BASE}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
