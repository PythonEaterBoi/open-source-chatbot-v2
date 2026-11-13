import type { ChatMessage, ModelCatalog } from "../types";
import { record } from "./diag";

export class ApiError extends Error {
  status: number;
  detail?: string;
  code?: string;
  constructor(message: string, status = 0, detail?: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.code = code;
  }
}

/**
 * Same origin proxy, or Pollinations directly when SERVER EGRESS IS BLOCKED.
 * Pollinations is explicitly designed for keyless client-side calls (it takes
 * a `referrer` instead of a key), so this is a legitimate fallback, not a
 * key leak — there is no secret to protect.
 */
const DIRECT_URL = "https://text.pollinations.ai/openai";
const DIRECT_MODELS = "https://text.pollinations.ai/models";
/** Pollinations wants a real referring site; a GitHub URL is safest. */
const REFERRER = "https://github.com/PythonEaterBoi/open-source-chatbot-v2";

/** Records locally for the Diagnostics panel, and best-effort on the server. */
function diagnose(stage: string, detail: Record<string, unknown>) {
  record("warn", stage, detail);
  try {
    void fetch("/api/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage, ...detail }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let logging break the chat */
  }
}

/** Turn a thrown fetch error into something a user can act on. */
function describeNetworkError(err: unknown): string {
  const msg = (err as Error)?.message ?? "";
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return "The browser could not reach Pollinations. A content blocker, DNS filter, VPN, or offline connection is the usual cause.";
  }
  return msg || "Network error";
}

export async function fetchModels(): Promise<ModelCatalog> {
  let res: Response;
  try {
    res = await fetch("/api/models");
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    const direct = await fetchDirectModels();
    if (direct) return direct;
    throw new ApiError("Could not load the model list", 0);
  }
  return validateCatalog(await res.json());
}

/**
 * The model payload comes from a third party, so never trust its shape —
 * a missing `models` array used to white-screen the whole app.
 */
function validateCatalog(raw: unknown): ModelCatalog {
  const data = raw as Partial<ModelCatalog> | null;
  if (!data || !Array.isArray(data.models)) {
    throw new ApiError("The model list was not in the expected format", 0);
  }
  const models = data.models
    .filter((m) => m && typeof m.id === "string")
    .map((m) => ({
      ...m,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      vendor: typeof m.vendor === "string" ? m.vendor : "Pollinations",
      blurb: typeof m.blurb === "string" ? m.blurb : "",
      tier: m.tier === "free" ? ("free" as const) : ("key" as const),
      tags: Array.isArray(m.tags) ? m.tags : [],
      available: m.available !== false,
      listed: m.listed !== false,
    }));
  return {
    models,
    source: data.source === "live" ? "live" : "fallback",
    defaultModel: typeof data.defaultModel === "string" ? data.defaultModel : "openai-fast",
  };
}

async function fetchDirectModels(): Promise<ModelCatalog | null> {
  try {
    const res = await fetch(DIRECT_MODELS, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    const models = data
      .filter((m: { output_modalities?: string[] }) =>
        (m.output_modalities ?? ["text"]).includes("text"),
      )
      .map((m: { name: string; description?: string; tier?: string; reasoning?: boolean }) => ({
        id: m.name,
        name: m.description?.split("(")[0]?.trim() || m.name,
        vendor: "Pollinations",
        blurb: m.description ?? "Advertised by Pollinations.",
        tier: m.tier === "anonymous" ? ("free" as const) : ("key" as const),
        tags: m.reasoning ? ["reasoning"] : [],
        available: m.tier === "anonymous",
        listed: true,
      }));
    if (!models.length) return null;
    return { models, source: "live", defaultModel: "openai-fast" };
  } catch {
    return null;
  }
}

interface StreamArgs {
  model: string;
  messages: Pick<ChatMessage, "role" | "content">[];
  temperature?: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onReasoning: (text: string) => void;
}

/** Streams a completion, preferring the server proxy. */
export async function streamChat(args: StreamArgs): Promise<void> {
  try {
    await streamViaProxy(args);
  } catch (err) {
    if (err instanceof ApiError && err.code === "upstream_unreachable") {
      diagnose("proxy_unreachable", { model: args.model });
      await streamDirect(args);
      return;
    }
    diagnose("proxy_error", {
      model: args.model,
      status: err instanceof ApiError ? err.status : 0,
      message: (err as Error)?.message,
    });
    throw err;
  }
}

async function streamViaProxy({
  model,
  messages,
  temperature,
  signal,
  onDelta,
  onReasoning,
}: StreamArgs) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, temperature, stream: true }),
    signal,
  });

  if (!res.ok) {
    let payload: { error?: string; detail?: string; code?: string } = {};
    try {
      payload = await res.json();
    } catch {
      /* non-json error body */
    }
    throw new ApiError(
      payload.error ?? `Request failed (HTTP ${res.status})`,
      res.status,
      payload.detail,
      payload.code,
    );
  }

  if (!res.body) throw new ApiError("The response had no body", 0);
  await pump(res.body, { onDelta, onReasoning });
}

async function streamDirect({
  model,
  messages,
  temperature,
  signal,
  onDelta,
  onReasoning,
}: StreamArgs) {
  // Order matters: try the richest request first, then degrade to shapes a
  // browser cannot refuse. A JSON POST triggers a CORS preflight; a "simple"
  // request (text/plain body) does not, so it survives endpoints that don't
  // answer OPTIONS properly.
  const attempts: DirectAttempt[] = [
    {
      label: "json-post",
      url: DIRECT_URL,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          referrer: REFERRER,
          ...(typeof temperature === "number" ? { temperature } : {}),
        }),
      },
    },
    {
      label: "text-post",
      url: DIRECT_URL,
      init: {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ model, messages, stream: true, referrer: REFERRER }),
      },
    },
    {
      label: "plain-get",
      url: `${DIRECT_URL.replace(/\/openai$/, "")}/${encodeURIComponent(
        buildTranscript(messages),
      )}?model=${encodeURIComponent(model)}&referrer=${encodeURIComponent(REFERRER)}`,
      init: { method: "GET" },
    },
  ];

  let lastError: ApiError | null = null;
  const networkFailures: string[] = [];

  for (const attempt of attempts) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    let res: Response;
    try {
      res = await fetch(attempt.url, { ...attempt.init, signal });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      networkFailures.push(`${attempt.label}: ${(err as Error)?.message}`);
      diagnose("direct_fetch_failed", {
        model,
        attempt: attempt.label,
        message: (err as Error)?.message,
      });
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      diagnose("direct_http_error", {
        model,
        attempt: attempt.label,
        status: res.status,
        body: body.slice(0, 300),
      });

      // 401/402 are policy answers, not transport failures: stop here and
      // explain, because no other shape of the same request will succeed.
      if (res.status === 401 || res.status === 402) {
        throw new ApiError(
          "This model needs a Pollinations API key or Pollen credits. Switch to the free GPT-OSS 20B model in the model menu.",
          res.status,
        );
      }
      if (res.status === 429) {
        throw new ApiError(
          "Pollinations is rate limiting this IP (the free tier allows about one request every 30 seconds). Wait a moment and try again.",
          429,
        );
      }
      lastError = new ApiError(`Pollinations returned HTTP ${res.status}.`, res.status);
      continue;
    }

    if (!res.body) {
      lastError = new ApiError("The response had no body", 0);
      continue;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isStream = contentType.includes("event-stream");

    if (isStream) {
      await pump(res.body, { onDelta, onReasoning });
    } else if (contentType.includes("application/json")) {
      const json = (await res.json()) as DirectJson;
      const text = json?.choices?.[0]?.message?.content ?? json?.text ?? "";
      if (!text) throw new ApiError("The model returned an empty response.", 0);
      onDelta(text);
    } else {
      // The GET endpoint answers with `data: {json}` frames (or plain text).
      const raw = await res.text();
      const parsed = readSseOrText(raw);
      if (!parsed) throw new ApiError("Unreadable response from Pollinations.", 0);
      onDelta(parsed);
    }
    return;
  }

  const explain = describeNetworkError(networkFailures[0] ?? "");
  diagnose("direct_all_failed", { model, networkFailures });
  throw new ApiError(
    lastError?.message ??
      `${explain} Tried ${attempts.length} request shapes without success.`,
    lastError?.status ?? 0,
  );
}

interface DirectAttempt {
  label: string;
  url: string;
  init: RequestInit;
}

interface DirectJson {
  choices?: { message?: { content?: string } }[];
  text?: string;
}

/** Flattens history into a single prompt for the GET endpoint. */
function buildTranscript(messages: Pick<ChatMessage, "role" | "content">[]): string {
  return messages
    .map((m) =>
      m.role === "assistant" ? `Assistant: ${m.content}` : m.content,
    )
    .join("\n\n");
}

/** Pulls the answer out of `data: {...}` SSE frames or a plain-text body. */
function readSseOrText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (!trimmed.startsWith("data:")) return trimmed;

  let out = "";
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("data:")) continue;
    const payload = l.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload) as DirectJson & {
        choices?: { delta?: { content?: string } }[];
      };
      out += json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? json?.text ?? "";
    } catch {
      out += payload;
    }
  }
  return out || trimmed;
}

/** Parses our normalized SSE frames, or a raw OpenAI stream from Pollinations. */
async function pump(
  body: ReadableStream<Uint8Array>,
  {
    onDelta,
    onReasoning,
  }: { onDelta: (t: string) => void; onReasoning: (t: string) => void },
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("data:"));
        if (!line) continue;

        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw);
        } catch {
          continue;
        }

        // Our normalized proxy protocol.
        if (typeof event.type === "string") {
          if (event.type === "delta" && typeof event.text === "string") {
            onDelta(event.text);
          } else if (event.type === "reasoning" && typeof event.text === "string") {
            onReasoning(event.text);
          } else if (event.type === "error") {
            throw new ApiError(
              typeof event.error === "string" ? event.error : "Stream failed",
            );
          }
          continue;
        }

        // Raw OpenAI chunk (browser-direct fallback).
        const choice = (event.choices as Array<Record<string, never>> | undefined)?.[0] as
          | {
              delta?: { content?: string; reasoning_content?: string };
            }
          | undefined;
        if (choice?.delta?.content) onDelta(choice.delta.content);
        if (choice?.delta?.reasoning_content) {
          onReasoning(choice.delta.reasoning_content);
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}
