import { useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Copy,
  RefreshCw,
  Brain,
} from "lucide-react";
import type { ChatMessage } from "../types";
import { Markdown } from "./Markdown";

interface Props {
  message: ChatMessage;
  streaming?: boolean;
  onRegenerate?: () => void;
  onRetry?: () => void;
}

export function Message({ message, streaming, onRegenerate, onRetry }: Props) {
  const [copied, setCopied] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const isUser = message.role === "user";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className={`msg${isUser ? " msg--user" : ""}`}>
      {!isUser && <div className="avatar avatar--assistant">A</div>}

      <div className="msg__body">
        {!isUser && (
          <div className="msg__meta">
            <strong>Assistant</strong>
            {message.model && <span>· {message.model}</span>}
          </div>
        )}

        {message.reasoning && (
          <div className="reasoning">
            <button
              type="button"
              className="reasoning__toggle"
              onClick={() => setShowReasoning((s) => !s)}
              aria-expanded={showReasoning}
            >
              <Brain size={13} />
              Thought for a moment
              <ChevronRight
                size={13}
                style={{
                  marginLeft: "auto",
                  transform: showReasoning ? "rotate(90deg)" : "none",
                  transition: "transform .15s ease",
                }}
              />
            </button>
            {showReasoning && (
              <div className="reasoning__body">{message.reasoning}</div>
            )}
          </div>
        )}

        {isUser ? (
          <div style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>
        ) : message.content ? (
          <Markdown text={message.content} />
        ) : streaming ? (
          <span className="caret" />
        ) : (
          <span className="typing">
            <span />
            <span />
            <span />
          </span>
        )}

        {streaming && message.content && <span className="caret" />}

        {message.error && (
          <div className="msg__error" role="alert">
            <AlertCircle size={15} style={{ flex: "none", marginTop: 2 }} />
            <div>
              <div>{message.error}</div>
              {onRetry && (
                <button
                  type="button"
                  className="side-link"
                  style={{ padding: "4px 0", color: "inherit", fontWeight: 600 }}
                  onClick={onRetry}
                >
                  Try again
                </button>
              )}
            </div>
          </div>
        )}

        {!isUser && !streaming && message.content && (
          <div className="msg__actions">
            <button
              type="button"
              className="icon-btn"
              onClick={copy}
              title={copied ? "Copied" : "Copy reply"}
              aria-label="Copy reply"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            {onRegenerate && (
              <button
                type="button"
                className="icon-btn"
                onClick={onRegenerate}
                title="Regenerate"
                aria-label="Regenerate reply"
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {isUser && <div className="avatar avatar--user">You</div>}
    </div>
  );
}
