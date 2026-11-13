import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Sparkles, KeyRound } from "lucide-react";
import type { ModelCatalog, ModelInfo } from "../types";

interface Props {
  catalog: ModelCatalog | null;
  value: string;
  onChange: (id: string) => void;
  loading?: boolean;
}

export function ModelSwitcher({ catalog, value, onChange, loading }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const models = catalog?.models ?? [];
  const current: ModelInfo | undefined = models.find((m) => m.id === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const free = models.filter((m) => m.tier === "free");
  const paid = models.filter((m) => m.tier !== "free");

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div className="switcher" data-open={open} ref={ref}>
      <button
        type="button"
        className="switcher__trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose a model"
      >
        <span
          className={`switcher__dot${current?.tier === "key" ? " switcher__dot--key" : ""}`}
        />
        <span className="switcher__name">
          {loading && !current ? "Loading models…" : (current?.name ?? value)}
        </span>
        <ChevronDown size={14} className="switcher__chev" />
      </button>

      {open && (
        <div className="menu" role="listbox" aria-label="Models">
          <div className="menu__head">
            <span>Model</span>
            <span className={`badge${catalog?.source === "live" ? " badge--live" : ""}`}>
              {catalog?.source === "live" ? "live list" : "offline list"}
            </span>
          </div>

          {free.length > 0 && (
            <>
              <div className="menu__head">
                <span>Free · no key</span>
              </div>
              {free.map((m) => (
                <Row key={m.id} model={m} active={m.id === value} onPick={pick} />
              ))}
            </>
          )}

          {paid.length > 0 && (
            <>
              <div className="menu__head">
                <span>May need a key</span>
              </div>
              {paid.map((m) => (
                <Row key={m.id} model={m} active={m.id === value} onPick={pick} />
              ))}
            </>
          )}

          <p className="menu__note">
            <Sparkles size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />
            Powered by <strong>Pollinations.ai</strong> — no API key, no signup.
            The anonymous tier currently serves GPT-OSS 20B free; other models may
            return a 401/402 until a key is added server-side.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({
  model,
  active,
  onPick,
}: {
  model: ModelInfo;
  active: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className="menu__item"
      onClick={() => onPick(model.id)}
    >
      <div className="menu__item-body">
        <div className="menu__item-row">
          <span className="menu__item-name">{model.name}</span>
          <span className="menu__item-vendor">{model.vendor}</span>
          {model.tier === "key" && (
            <KeyRound size={11} style={{ color: "var(--text-muted)" }} />
          )}
        </div>
        <div className="menu__item-blurb">{model.blurb}</div>
      </div>
      {active && <Check size={15} className="menu__check" />}
    </button>
  );
}
