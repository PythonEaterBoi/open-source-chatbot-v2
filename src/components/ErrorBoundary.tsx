import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string;
}

/**
 * Without this, any render-time error leaves a blank white page and the user
 * has nothing to report. With it, they can copy the real message.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info: info.componentStack ?? "" });
    console.error("[render-error]", error, info);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const report = [
      `Error: ${error.name}: ${error.message}`,
      "",
      `URL: ${location.href}`,
      `UA: ${navigator.userAgent}`,
      "",
      "stack:",
      error.stack ?? "(none)",
      "",
      "component stack:",
      info || "(none)",
    ].join("\n");

    return (
      <div
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: 24,
          fontFamily: '"Inter", system-ui, sans-serif',
          background: "#faf9f5",
          color: "#141413",
        }}
      >
        <div style={{ maxWidth: 640, width: "100%" }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background: "#d97757",
              display: "grid",
              placeItems: "center",
              color: "#fbf7f2",
              fontFamily: '"Lora", Georgia, serif',
              fontSize: 22,
              fontWeight: 700,
              marginBottom: 18,
            }}
          >
            !
          </div>
          <h1
            style={{
              fontFamily: '"Lora", Georgia, serif',
              fontWeight: 500,
              fontSize: 26,
              letterSpacing: "-0.02em",
              margin: "0 0 8px",
            }}
          >
            The interface hit an error
          </h1>
          <p style={{ color: "#575653", margin: "0 0 16px", lineHeight: 1.6 }}>
            Reloading usually clears it. If it keeps happening, copy the details
            below into a bug report.
          </p>
          <pre
            style={{
              background: "#f4f2ec",
              border: "1px solid #e4e1d6",
              borderRadius: 12,
              padding: 14,
              fontSize: 12,
              lineHeight: 1.6,
              overflow: "auto",
              maxHeight: 300,
              whiteSpace: "pre-wrap",
              margin: "0 0 16px",
            }}
          >
            {report}
          </pre>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              onClick={() => location.reload()}
              style={{
                background: "#d97757",
                color: "#fff9f5",
                border: "none",
                borderRadius: 10,
                padding: "9px 16px",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(report)}
              style={{
                background: "transparent",
                color: "#575653",
                border: "1px solid #d5d0c1",
                borderRadius: 10,
                padding: "9px 16px",
                fontWeight: 550,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Copy details
            </button>
          </div>
        </div>
      </div>
    );
  }
}
