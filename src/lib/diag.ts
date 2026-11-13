/**
 * A tiny in-app event log. Everything the chat does that could fail lands
 * here, and the Diagnostics panel renders it. This is deliberately dependency
 * free so it can never be the reason the app fails to boot.
 */

export interface DiagEvent {
  at: number;
  level: "info" | "warn" | "error";
  stage: string;
  detail?: Record<string, unknown>;
}

type Listener = () => void;

const MAX = 80;
const events: DiagEvent[] = [];
const listeners = new Set<Listener>();

export function record(
  level: DiagEvent["level"],
  stage: string,
  detail?: Record<string, unknown>,
) {
  events.push({ at: Date.now(), level, stage, detail });
  if (events.length > MAX) events.shift();
  listeners.forEach((l) => l());
}

export function getEvents(): DiagEvent[] {
  return [...events];
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export interface Probe {
  label: string;
  url: string;
  ok: boolean | null; // null = still running
  ms?: number;
  note?: string;
}

export const probes: Probe[] = [
  { label: "Server", url: "/api/health", ok: null },
  {
    label: "Pollinations",
    url: "https://text.pollinations.ai/models",
    ok: null,
  },
];

/** Fires the reachability probes and returns the (mutated) probe list. */
export async function runProbes(): Promise<Probe[]> {
  for (const probe of probes) {
    probe.ok = null;
    probe.ms = undefined;
    probe.note = undefined;
  }

  await Promise.all(
    probes.map(async (probe) => {
      const started = performance.now();
      try {
        const res = await fetch(probe.url, { method: "GET" });
        probe.ms = Math.round(performance.now() - started);
        probe.ok = res.ok;
        if (!res.ok) probe.note = `HTTP ${res.status}`;
      } catch (err) {
        probe.ms = Math.round(performance.now() - started);
        probe.ok = false;
        probe.note = (err as Error)?.message ?? "blocked";
      }
      listeners.forEach((l) => l());
    }),
  );

  record("info", "probes", {
    server: probes[0].ok,
    pollinations: probes[1].ok,
  });
  return probes;
}

/** A block of text the user can paste into a bug report. */
export function buildReport(): string {
  const lines = [
    `Generated ${new Date().toISOString()}`,
    `URL: ${location.href}`,
    `UA: ${navigator.userAgent}`,
    `Online: ${navigator.onLine}`,
    "",
    "probes:",
    ...probes.map(
      (p) => `  ${p.label}: ${p.ok === null ? "pending" : p.ok ? "ok" : "FAILED"} (${p.ms ?? "?"}ms)${p.note ? ` — ${p.note}` : ""}`,
    ),
    "",
    "events:",
    ...getEvents().map(
      (e) =>
        `  ${new Date(e.at).toISOString()} [${e.level}] ${e.stage}${
          e.detail ? ` ${JSON.stringify(e.detail)}` : ""
        }`,
    ),
  ];
  return lines.join("\n");
}
