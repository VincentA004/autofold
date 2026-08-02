import { Show, type JSX } from "solid-js"
import { useDialog } from "@synsci/ui/context/dialog"
import { useServer } from "@/context/server"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"

/**
 * Banner shown when the local openscience server is confirmed unreachable
 * (healthy() === false — never on the initial `undefined` checking state, to
 * avoid a flash on first load). The health probe re-polls every 10s, so the
 * banner clears itself on recovery.
 */
export function DisconnectedPanel(): JSX.Element {
  const server = useServer()
  const dialog = useDialog()

  return (
    <Show when={server.healthy() === false}>
      <div
        role="alert"
        aria-label="Server connection lost"
        style={{
          display: "flex",
          "align-items": "center",
          gap: "12px",
          padding: "9px 18px",
          background: "var(--color-error-muted, rgba(239,68,68,0.15))",
          "border-bottom": "1px solid var(--color-error, #ef4444)",
          "flex-shrink": 0,
        }}
      >
        <span
          style={{
            width: "7px",
            height: "7px",
            "border-radius": "50%",
            background: "var(--color-error, #ef4444)",
            "flex-shrink": 0,
          }}
        />
        <div style={{ flex: 1, "min-width": 0 }}>
          <div
            style={{ "font-family": FONT_SANS, "font-size": "12.5px", "font-weight": 500, color: "var(--color-text)" }}
          >
            Can't reach your local Autofold server
          </div>
          <div
            style={{
              "font-family": FONT_MONO,
              "font-size": "10.5px",
              color: "var(--color-text-muted)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            {server.name} ·{" "}
            <Show when={server.isLocal()} fallback="check the server URL or switch servers">
              start it with <code>openscience serve</code>
            </Show>
            <Show when={server.failures() > 1}> · {server.failures()} failed checks</Show>
          </div>
        </div>
        <button
          type="button"
          disabled={server.checking()}
          onClick={() => void server.refresh()}
          style={{
            all: "unset",
            cursor: server.checking() ? "wait" : "pointer",
            padding: "6px 12px",
            "border-radius": "4px",
            border: "1px solid var(--color-error, #ef4444)",
            background: "var(--color-error, #ef4444)",
            "font-family": FONT_MONO,
            "font-size": "11px",
            color: "white",
            opacity: server.checking() ? 0.7 : 1,
            "flex-shrink": 0,
          }}
        >
          {server.checking() ? "checking…" : "retry now"}
        </button>
        <button
          type="button"
          onClick={() => dialog.show(() => <DialogSelectServer />)}
          style={{
            all: "unset",
            cursor: "pointer",
            padding: "6px 12px",
            "border-radius": "4px",
            border: "1px solid var(--color-border-strong)",
            background: "var(--color-surface-solid)",
            "font-family": FONT_MONO,
            "font-size": "11px",
            color: "var(--color-text)",
            "flex-shrink": 0,
          }}
        >
          switch server
        </button>
      </div>
    </Show>
  )
}
