import { Show } from "solid-js"
import { createKeyed, type SessionRef, usePlugin } from "@opencode/plugin/gui"
import type { Definition } from "../definition"
import { isSubmitKey } from "../logic"
import type { SideChatModel } from "../model"

const MAX_HEIGHT = 200

/**
 * The chat's composer: Enter sends (not while an IME composes), Shift+Enter adds a line, and a Stop button replaces
 * Send while the fork works. Its text is the chat's draft, kept while the window is open.
 */
export function Composer(props: {
  readonly model: SideChatModel
  readonly session: SessionRef
  readonly id: string
  readonly running: boolean
  readonly selection: string
  readonly onQuoteSelection: () => void
}) {
  const ctx = usePlugin<Definition>()
  let field: HTMLTextAreaElement | undefined

  const fit = () => {
    if (!field) return
    field.style.height = "auto"
    field.style.height = `${Math.min(field.scrollHeight, MAX_HEIGHT)}px`
  }

  const send = () => {
    props.model.send(props.session, props.id)
    queueMicrotask(fit)
  }

  // A focus request from opening the chat (or its tab): focus once, with the cursor at the end.
  createKeyed(
    () => props.model.focusTick(props.id) || undefined,
    (tick) => {
      if (!props.model.takeFocus(props.id, tick)) return
      requestAnimationFrame(() => {
        if (!field) return
        field.focus()
        field.setSelectionRange(field.value.length, field.value.length)
      })
    },
  )

  return (
    <>
      <textarea
        ref={(element) => {
          field = element
          queueMicrotask(fit)
        }}
        class="osc-textarea"
        rows={2}
        value={props.model.draft(props.id)}
        placeholder={ctx.t("composer.placeholder")}
        aria-label={ctx.t("composer.label")}
        onInput={(event) => {
          props.model.setDraft(props.id, event.currentTarget.value)
          fit()
        }}
        onKeyDown={(event) => {
          if (!isSubmitKey(event)) return
          event.preventDefault()
          if (!props.running) send()
        }}
      />
      <div class="osc-spread">
        <div class="osc-row">
          <Show when={props.selection.trim()}>
            {/* Keeps the transcript selection alive while the button takes the press. */}
            <span onMouseDown={(event) => event.preventDefault()}>
              <ctx.ui.Button size="small" variant="ghost-muted" icon="outline-quote" onClick={() => props.onQuoteSelection()}>
                {ctx.t("quote.selection")}
              </ctx.ui.Button>
            </span>
          </Show>
        </div>
        <Show
          when={props.running}
          fallback={
            <ctx.ui.Tooltip value={ctx.t("composer.send")} keys={["Enter"]}>
              <ctx.ui.IconButton
                icon="arrow-up"
                label={ctx.t("composer.send")}
                size="small"
                variant="neutral"
                disabled={!props.model.draft(props.id).trim()}
                onClick={send}
              />
            </ctx.ui.Tooltip>
          }
        >
          <ctx.ui.Tooltip value={ctx.t("composer.stop")}>
            <ctx.ui.IconButton
              icon="stop"
              label={ctx.t("composer.stop")}
              size="small"
              variant="neutral"
              onClick={() => props.model.stop(props.session, props.id)}
            />
          </ctx.ui.Tooltip>
        </Show>
      </div>
    </>
  )
}
