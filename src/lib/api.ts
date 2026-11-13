import type { ChatMessage, ModelCatalog } from "../types";

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
const REFERRER = "open-source-chatbot-v2";

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
  return (await res.json()) as ModelCatalog;
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
      await streamDirect(args);
      return;
    }
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
  let res: Response;
  try {
    res = await fetch(DIRECT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        referrer: REFERRER,
        ...(typeof temperature === "number" ? { temperature } : {}),
      }),
      signal,
    });
  } catch {
    throw new ApiError(
      "Can't reach Pollinations from this browser either. Check your internet connection or any content blocker.",
      0,
    );
  }

  if (!res.ok) {
    throw new ApiError(
      res.status === 429
        ? "Pollinations is rate limiting this IP (free tier allows about one request every 30 seconds). Wait a moment and try again."
        : res.status === 402 || res.status === 401
          ? "This model needs a Pollinations API key or Pollen credits. Switch to the free GPT-OSS 20B model."
          : `Pollinations returned HTTP ${res.status}.`,
      res.status,
    );
  }

  if (!res.body) throw new ApiError("The response had no body", 0);
  await pump(res.body, { onDelta, onReasoning });
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
