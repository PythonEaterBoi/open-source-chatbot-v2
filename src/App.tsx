import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Code2,
  Feather,
  Github,
  MessageSquarePlus,
  Moon,
  PanelLeft,
  PenLine,
  Search,
  Sparkles,
  Sun,
  Trash2,
  X,
  Activity,
} from "lucide-react";
import { Composer } from "./components/Composer";
import { Message } from "./components/Message";
import { ModelSwitcher } from "./components/ModelSwitcher";
import { Diagnostics } from "./components/Diagnostics";
import { record } from "./lib/diag";
import { streamChat, fetchModels, ApiError } from "./lib/api";
import {
  loadActiveId,
  loadConversations,
  loadTheme,
  saveActiveId,
  saveConversations,
  saveTheme,
  titleFrom,
  uid,
} from "./lib/storage";
import type { ChatMessage, Conversation, ModelCatalog } from "./types";

const MODEL_PREF_KEY = "pchat.model.v1";

function emptyConversation(model: string): Conversation {
  const now = Date.now();
  return {
    id: uid(),
    title: "New chat",
    model,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

const SUGGESTIONS = [
  {
    icon: PenLine,
    text: "Draft a warm, three-paragraph note thanking a mentor who helped me switch careers.",
  },
  {
    icon: Code2,
    text: "Explain JavaScript closures to me like I'm a smart beginner, with one example.",
  },
  {
    icon: Feather,
    text: "Help me brainstorm names for a cozy neighborhood coffee shop with a reading nook.",
  },
  {
    icon: BookOpen,
    text: "Summarize the key ideas of a topic I'm curious about and ask me which to go deeper on.",
  },
];

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [diagOpen, setDiagOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  // ------------------------------------------------------------- bootstrap
  useEffect(() => {
    const stored = loadConversations();
    const storedActive = loadActiveId();
    setTheme(loadTheme());

    let model = "openai-fast";
    try {
      model = localStorage.getItem(MODEL_PREF_KEY) || model;
    } catch {
      /* ignore */
    }

    if (stored.length > 0) {
      setConversations(stored);
      setActiveId(stored.find((c) => c.id === storedActive)?.id ?? stored[0].id);
    } else {
      const fresh = emptyConversation(model);
      setConversations([fresh]);
      setActiveId(fresh.id);
    }
  }, []);

  useEffect(() => {
    if (conversations.length) saveConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    saveActiveId(activeId);
  }, [activeId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    fetchModels()
      .then(setCatalog)
      .catch(() => setCatalog(null))
      .finally(() => setCatalogLoading(false));
  }, []);

  // --------------------------------------------------------------- helpers
  const patchConversation = useCallback(
    (id: string, patch: (c: Conversation) => Conversation) => {
      setConversations((list) =>
        list.map((c) => (c.id === id ? patch(c) : c)),
      );
    },
    [],
  );

  const setModel = useCallback(
    (id: string) => {
      if (active) patchConversation(active.id, (c) => ({ ...c, model: id }));
      try {
        localStorage.setItem(MODEL_PREF_KEY, id);
      } catch {
        /* ignore */
      }
    },
    [active, patchConversation],
  );

  const newChat = useCallback(() => {
    if (streaming) abortRef.current?.abort();
    const model = active?.model ?? catalog?.defaultModel ?? "openai-fast";
    const existingEmpty = conversations.find((c) => c.messages.length === 0);
    if (existingEmpty) {
      setActiveId(existingEmpty.id);
      setSidebarOpen(false);
      return;
    }
    const fresh = emptyConversation(model);
    setConversations((list) => [fresh, ...list]);
    setActiveId(fresh.id);
    setInput("");
    setSidebarOpen(false);
  }, [active, catalog, conversations, streaming]);

  const deleteChat = useCallback(
    (id: string) => {
      const next = conversations.filter((c) => c.id !== id);
      if (next.length === 0) {
        const fresh = emptyConversation(catalog?.defaultModel ?? "openai-fast");
        setConversations([fresh]);
        setActiveId(fresh.id);
        return;
      }
      setConversations(next);
      if (id === activeId) setActiveId(next[0].id);
    },
    [activeId, catalog, conversations],
  );

  // ---------------------------------------------------------------- stream
  const runCompletion = useCallback(
    async (convId: string, history: ChatMessage[], model: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);

      const replyId = uid();
      const placeholder: ChatMessage = {
        id: replyId,
        role: "assistant",
        content: "",
        model,
        at: Date.now(),
      };

      patchConversation(convId, (c) => ({
        ...c,
        messages: [...c.messages, placeholder],
        updatedAt: Date.now(),
      }));

      const patchReply = (fn: (m: ChatMessage) => ChatMessage) =>
        patchConversation(convId, (c) => ({
          ...c,
          messages: c.messages.map((m) => (m.id === replyId ? fn(m) : m)),
          updatedAt: Date.now(),
        }));

      let acc = "";
      let reasoning = "";

      try {
        await streamChat({
          model,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          signal: controller.signal,
          onDelta: (text) => {
            acc += text;
            patchReply((m) => ({ ...m, content: acc }));
          },
          onReasoning: (text) => {
            reasoning += text;
            patchReply((m) => ({ ...m, reasoning }));
          },
        });

        if (!acc.trim()) {
          patchReply((m) => ({
            ...m,
            content: m.content || "_The model returned an empty response._",
          }));
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          patchReply((m) => ({
            ...m,
            content: m.content || "_Generation stopped._",
          }));
        } else {
          const message =
            err instanceof ApiError
              ? err.message
              : ((err as Error)?.message ?? "Something went wrong.");
          patchReply((m) => ({
            ...m,
            content: m.content,
            error: message,
          }));
          if (reasoning) patchReply((m) => ({ ...m, reasoning }));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [patchConversation],
  );

  const send = useCallback(
    (text: string) => {
      if (!active || streaming) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      const userMsg: ChatMessage = {
        id: uid(),
        role: "user",
        content: trimmed,
        at: Date.now(),
      };

      const isFirst = active.messages.length === 0;
      const history = [...active.messages, userMsg];
      const model = active.model || catalog?.defaultModel || "openai-fast";

      record("info", "send", { model, chars: trimmed.length, turns: history.length });
      stickToBottom.current = true;
      patchConversation(active.id, (c) => ({
        ...c,
        title: isFirst ? titleFrom(trimmed) : c.title,
        messages: history,
        updatedAt: Date.now(),
      }));
      setInput("");
      void runCompletion(active.id, history, model);
    },
    [active, catalog, patchConversation, runCompletion, streaming],
  );

  const regenerate = useCallback(() => {
    if (!active || streaming) return;
    // Truncate back to the last user turn, then replay it.
    const msgs = [...active.messages];
    while (msgs.length && msgs[msgs.length - 1].role !== "user") msgs.pop();
    if (!msgs.length) return;
    const model = active.model || catalog?.defaultModel || "openai-fast";
    patchConversation(active.id, (c) => ({
      ...c,
      messages: msgs,
      updatedAt: Date.now(),
    }));
    void runCompletion(active.id, msgs, model);
  }, [active, catalog, patchConversation, runCompletion, streaming]);

  const retryLast = useCallback(() => {
    if (!active || streaming) return;
    const msgs = active.messages.filter((m) => !m.error);
    // remove the failed assistant placeholder
    while (msgs.length && msgs[msgs.length - 1].role === "assistant") msgs.pop();
    if (!msgs.length) return;
    void runCompletion(active.id, msgs, active.model);
  }, [active, runCompletion, streaming]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ---------------------------------------------------------------- scroll
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottom.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [active?.messages, streaming]);

  // ------------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        newChat();
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setTheme((t) => (t === "light" ? "dark" : "light"));
      }
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!q) return list;
    return list.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q)),
    );
  }, [conversations, query]);

  const currentModelName =
    catalog?.models?.find((m) => m.id === active?.model)?.name ??
    active?.model ??
    "AI";

  const isEmpty = !active || active.messages.length === 0;

  return (
    <div className="app">
      {sidebarOpen && (
        <div className="scrim" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className="sidebar" data-open={sidebarOpen}>
        <div className="sidebar__top">
          <div className="brand">
            <div className="brand__mark">A</div>
            <div>
              <div className="brand__name">Aria</div>
              <div className="brand__tag">open source chat</div>
            </div>
            <button
              type="button"
              className="icon-btn menu-btn"
              style={{ marginLeft: "auto" }}
              onClick={() => setSidebarOpen(false)}
              aria-label="Close sidebar"
            >
              <X size={16} />
            </button>
          </div>

          <button type="button" className="new-chat" onClick={newChat}>
            <MessageSquarePlus size={16} />
            New chat
            <span className="side-link__kbd" style={{ marginLeft: "auto" }}>
              ⌘K
            </span>
          </button>
        </div>

        <div className="sidebar__search">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search chats"
          />
        </div>

        <div className="sidebar__label">
          {query ? "Results" : "Recents"}
        </div>

        <nav className="chat-list" aria-label="Chat history">
          {filtered.map((c) => (
            <div key={c.id} className="chat-item" aria-current={c.id === activeId}>
              <button
                type="button"
                className="chat-item__select"
                onClick={() => {
                  setActiveId(c.id);
                  setSidebarOpen(false);
                }}
                title={c.title}
              >
                {c.title}
              </button>
              <span className="chat-item__actions">
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  title="Delete chat"
                  aria-label={`Delete ${c.title}`}
                  onClick={() => deleteChat(c.id)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          ))}
          {filtered.length === 0 && (
            <p
              style={{
                padding: "8px 12px",
                fontSize: 12.5,
                color: "var(--text-muted)",
              }}
            >
              No chats match “{query}”.
            </p>
          )}
        </nav>

        <div className="sidebar__footer">
          <button
            type="button"
            className="side-link"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
            {theme === "light" ? "Dark mode" : "Light mode"}
            <span className="side-link__kbd">⇧⌘O</span>
          </button>
          <button
            type="button"
            className="side-link"
            onClick={() => setDiagOpen(true)}
          >
            <Activity size={15} />
            Diagnostics
          </button>
          <a
            className="side-link"
            href="https://pollinations.ai"
            target="_blank"
            rel="noreferrer"
          >
            <Sparkles size={15} />
            Pollinations.ai
          </a>
          <a
            className="side-link"
            href="https://github.com/PythonEaterBoi/open-source-chatbot-v2"
            target="_blank"
            rel="noreferrer"
          >
            <Github size={15} />
            Source
          </a>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn menu-btn"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
          >
            <PanelLeft size={17} />
          </button>
          <span className="topbar__title">{active?.title ?? "New chat"}</span>
          <span className="topbar__spacer" />
          <ModelSwitcher
            catalog={catalog}
            value={active?.model ?? catalog?.defaultModel ?? "openai-fast"}
            onChange={setModel}
            loading={catalogLoading}
          />
        </header>

        {isEmpty ? (
          <div className="hero">
            <div className="hero__inner">
              <div className="hero__mark">A</div>
              <h1>
                Good to see you. What should we <em>think about</em> today?
              </h1>
              <p className="hero__sub">
                A keyless AI chat running on {currentModelName} via
                Pollinations.ai. Pick a different model any time from the
                switcher up top.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map(({ icon: Icon, text }) => (
                  <button
                    key={text}
                    type="button"
                    className="suggestion"
                    onClick={() => send(text)}
                  >
                    <Icon size={15} />
                    <span>{text}</span>
                  </button>
                ))}
              </div>
              <p className="hero__hint">
                <Sparkles size={12} />
                No API key, no account · <kbd>⌘K</kbd> for a new chat
              </p>
            </div>
          </div>
        ) : (
          <div className="thread" ref={threadRef} role="log" aria-live="polite" aria-label="Conversation">
            <div className="thread__inner">
              <div className="thread__top-space" />
              {active.messages.map((m, i) => (
                <Message
                  key={m.id}
                  message={m}
                  streaming={
                    streaming &&
                    i === active.messages.length - 1 &&
                    m.role === "assistant"
                  }
                  onRegenerate={
                    m.role === "assistant" && !streaming ? regenerate : undefined
                  }
                  onRetry={m.error ? retryLast : undefined}
                />
              ))}
              <div style={{ height: 8 }} />
            </div>
          </div>
        )}

        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => send(input)}
          onStop={stop}
          streaming={streaming}
          modelName={currentModelName}
          disabled={!active}
        />
      </main>

      <Diagnostics open={diagOpen} onClose={() => setDiagOpen(false)} />
    </div>
  );
}
