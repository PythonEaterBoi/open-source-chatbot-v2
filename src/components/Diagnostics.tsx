import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw, X, CircleAlert, CircleCheck, CircleDashed } from "lucide-react";
import {
  buildReport,
  getEvents,
  probes,
  runProbes,
  subscribe,
  type DiagEvent,
} from "../lib/diag";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function Diagnostics({ open, onClose }: Props) {
  const [events, setEvents] = useState<DiagEvent[]>(getEvents());
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => subscribe(() => setEvents(getEvents())), []);

  useEffect(() => {
    if (!open) return;
    setBusy(true);
    void runProbes().finally(() => setBusy(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildReport());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div
        className="diag"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diag-title"
      >
        <div className="diag__head">
          <div>
            <h2 id="diag-title">Diagnostics</h2>
            <p>Check reachability and see what the chat actually did.</p>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              className="icon-btn"
              title="Re-run checks"
              aria-label="Re-run checks"
              onClick={() => {
                setBusy(true);
                void runProbes().finally(() => setBusy(false));
              }}
            >
              <RefreshCw size={15} className={busy ? "spin" : undefined} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label="Close diagnostics"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="diag__probes">
          {probes.map((p) => (
            <div className="diag__probe" key={p.label}>
              <span
                className={`diag__pip ${
                  p.ok === null ? "is-pending" : p.ok ? "is-ok" : "is-bad"
                }`}
              >
                {p.ok === null ? (
                  <CircleDashed size={14} />
                ) : p.ok ? (
                  <CircleCheck size={14} />
                ) : (
                  <CircleAlert size={14} />
                )}
              </span>
              <span className="diag__probe-label">{p.label}</span>
              <span className="diag__probe-note">
                {p.ok === null ? "checking…" : p.ok ? `ok · ${p.ms}ms` : (p.note ?? "failed")}
              </span>
            </div>
          ))}
        </div>

        {events.length === 0 ? (
          <p className="diag__empty">
            No events yet. Send a message and they'll appear here.
          </p>
        ) : (
          <ul className="diag__events">
            {events
              .slice()
              .reverse()
              .map((e, i) => (
                <li key={`${e.at}-${i}`} className={`diag__event is-${e.level}`}>
                  <span className="diag__time">
                    {new Date(e.at).toLocaleTimeString()}
                  </span>
                  <span className="diag__stage">{e.stage}</span>
                  {e.detail && (
                    <code className="diag__detail">
                      {JSON.stringify(e.detail)}
                    </code>
                  )}
                </li>
              ))}
          </ul>
        )}

        <div className="diag__foot">
          <button type="button" className="diag__copy" onClick={copy}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy report"}
          </button>
          <span>Paste this into a bug report if something looks wrong.</span>
        </div>
      </div>
    </>
  );
}
