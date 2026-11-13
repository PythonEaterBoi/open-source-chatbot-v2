# open-source-chatbot-v2

A keyless AI chat client. **No API keys, no accounts, no signup** — every reply
comes from [Pollinations.ai](https://pollinations.ai) through a small Node proxy.
It wears a Claude-inspired theme: warm cream canvas, **Lora** serif for prose,
Inter for UI, and Claude's coral-orange accent (`#D97757`).

## Features

- **AI chat that streams** token by token, with a stop button, retry, regenerate
  and copy.
- **Model switcher** in the header. The list is fetched live from
  `text.pollinations.ai/models` and merged with a curated catalog, so it adapts
  when Pollinations adds or retires models.
- **Zero keys.** No key exists anywhere. Requests go through the Express proxy,
  with an automatic browser-direct fallback if the host can't reach
  Pollinations.
- **Markdown replies** with GFM tables, task lists, syntax-highlighted code
  blocks and a per-block copy button.
- **Reasoning trace** disclosure for reasoning models (GPT-OSS).
- **Chat history** in `localStorage`: search, switch, delete.
- **Light / dark** themes following the system preference by default.
- Responsive down to mobile, full keyboard shortcuts, reduced-motion support.

## Getting started

Requires Node 18+ (Node 20/22 recommended; uses global `fetch`).

```bash
npm install
npm run dev          # http://localhost:5173
```

Production:

```bash
npm run build
npm start            # serves dist/ + /api on :5173
```

## How it works

```
browser ──POST /api/chat──▶ Express ──POST text.pollinations.ai/openai──▶ Pollinations
   ▲                            │
   └───── SSE (normalized) ─────┘

if the server has no route to Pollinations (locked-down / sandboxed network):

browser ──────────────────── POST text.pollinations.ai/openai ──────────▶ Pollinations
```

The direct path degrades through three request shapes — a JSON POST, a
"simple" `text/plain` POST (which skips the CORS preflight), and finally the
GET endpoint — so one of them gets through on most networks.

Both paths use the same keyless endpoint. The proxy is preferred because it
normalizes the stream, retries on `429`, and keeps the request shape consistent;
the direct path exists so the app still works when the host has no egress. Since
Pollinations accepts a `referrer` instead of a key, there is no secret in the
browser either way.

Pollinations speaks the OpenAI chat-completions format, but its stream shape and
plain-text quirks vary by model. The server normalizes everything into a tiny SSE
protocol of our own:

```json
{ "type": "delta",     "text": "..." }
{ "type": "reasoning", "text": "..." }
{ "type": "done" }
{ "type": "error",     "error": "..." }
```

That keeps the client simple and means swapping providers later only touches one
file (`server/index.mjs`).

### Endpoints

| Method | Path          | Purpose                                             |
| ------ | ------------- | --------------------------------------------------- |
| `GET`  | `/api/models` | Live model list merged with the curated catalog     |
| `GET`  | `/api/health` | Liveness + the upstream URL in use                   |
| `POST` | `/api/chat`   | Streams a completion (`{ model, messages, stream }`) |
| `POST` | `/api/log`    | Browser-side failure reports (visible in server logs) |
| `GET`  | `/api/diag`   | Last 50 client reports, newest first                 |

### Configuration

All optional, via environment variables:

| Variable                 | Default                              | Meaning                                  |
| ------------------------ | ------------------------------------ | ---------------------------------------- |
| `PORT`                   | `5173`                               | Port to bind (`0.0.0.0`)                 |
| `POLLINATIONS_BASE_URL`  | `https://text.pollinations.ai/openai`| Chat completions endpoint                |
| `POLLINATIONS_MODELS_URL`| `https://text.pollinations.ai/models`| Model discovery endpoint                 |
| `MIN_REQUEST_GAP_MS`     | `1200`                               | Local per-IP debounce                    |
| `RETRY_CAP_MS`           | `6000`                               | Longest single backoff wait on a 429     |

## Models

The **free, keyless** tier currently serves `openai-fast` (GPT-OSS 20B, reasoning
enabled). Other entries in the switcher (`openai-large`, `claude`, `gemini`,
`deepseek`, …) may return `401`/`402` because Pollinations now gates them behind
keys and Pollen credits — the UI labels those as "may need a key" and turns the
error into a readable message suggesting the free model.

The switcher shows a **live list** badge when `/api/models` reached Pollinations,
and **offline list** when it fell back to the bundled catalog.

### Offline / blocked networks

If the server can't reach `text.pollinations.ai` (corporate proxy, regional
block, sandboxed CI), `/api/chat` responds with `code: "upstream_unreachable"`
and the browser retries Pollinations directly. The model switcher does the same
for `/api/models` and simply shows the bundled catalog if both fail.

### Rate limits

The anonymous tier allows roughly **one request per IP every 30 seconds**. The
server retries a couple of times with backoff before giving up, but sustained
fast back-and-forth will hit `429`. Adding a Pollinations key server-side
(`Authorization: Bearer …` on the upstream fetch) removes this limit.

## Project layout

```
index.html
server/index.mjs        Express: Vite middleware (dev) / static dist (prod) + API
src/
  App.tsx               Shell: sidebar, thread, composer, shortcuts, streaming
  components/
    Composer.tsx        Auto-growing textarea, send/stop
    Message.tsx         Bubbles, reasoning disclosure, actions
    Markdown.tsx        react-markdown + GFM + highlight, copy-able code blocks
    ModelSwitcher.tsx   Accessible listbox with free / key-required groups
  lib/
    api.ts              SSE client + typed errors
    storage.ts          Conversations, theme, model preference
  styles.css            The Claude-ish design tokens & all styling
  types.ts
```

## Notes

- Conversations live only in your browser's `localStorage`; nothing is persisted
  server-side.
- Pollinations is a third-party service — replies can be inaccurate, and your
  prompts are sent to them. Don't paste secrets into the chat.
- No API keys are stored or required anywhere in this repo.

## License

MIT
