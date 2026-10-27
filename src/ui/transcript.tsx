import { createSignal, For, Match, Show, Switch } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { Definition } from "../definition"
import { assistantText, toolSummary } from "../logic"
import type { Message } from "../model"

type Assistant = Extract<Message, { type: "assistant" }>
type Part = Assistant["content"][number]
type Tool = Extract<Part, { type: "tool" }>

/** A message the chat sent that the server has not delivered yet. */
export interface Queued {
  readonly id: string
  readonly text: string
}

/** The side chat's own messages: the user's, the replies, tool calls as one line each, and a working indicator. */
export function Transcript(props: {
  readonly messages: readonly Message[]
  readonly queued: readonly Queued[]
  readonly running: boolean
  readonly onQuote: (text: string) => void
}) {
  const ctx = usePlugin<Definition>()

  return (
    <>
      <For each={props.messages}>
        {(message) => (
          <Switch>
            <Match when={message.type === "user" && message}>
              {(user) => (
                <div class="osc-msg osc-user">
                  <ctx.ui.Markdown text={user().text} />
                </div>
              )}
            </Match>
            <Match when={message.type === "assistant" && message}>
              {(assistant) => <AssistantMessage message={assistant()} onQuote={props.onQuote} />}
            </Match>
            <Match when={message.type === "shell" && message}>
              {(shell) => (
                <Collapsible
                  name="$"
                  summary={shell().command}
                  status={shell().status === "running" ? "running" : shell().exit === 0 ? "done" : "failed"}
                >
                  <pre class="osc-pre">{shell().output?.output ?? ""}</pre>
                </Collapsible>
              )}
            </Match>
            <Match when={message.type === "synthetic" && message}>
              {(synthetic) => <div class="osc-msg osc-note">{synthetic().description ?? synthetic().text}</div>}
            </Match>
            <Match when={message.type === "idle" && message}>
              {(idle) => (
                <div class="osc-msg osc-note">
                  {idle().outcome === "interrupted" ? ctx.t("stopped") : `${ctx.t("failed")}${idle().error ? `: ${idle().error?.message}` : ""}`}
                </div>
              )}
            </Match>
          </Switch>
        )}
      </For>
      <For each={props.queued}>
        {(item) => (
          <div class="osc-msg osc-user osc-queued" title={ctx.t("queued")}>
            <ctx.ui.Markdown text={item.text} />
          </div>
        )}
      </For>
      <Show when={props.running}>
        <div class="osc-working" role="status">
          <ctx.ui.Loader size="small" />
          <span>{ctx.t("working")}</span>
        </div>
      </Show>
    </>
  )
}

function AssistantMessage(props: { readonly message: Assistant; readonly onQuote: (text: string) => void }) {
  const ctx = usePlugin<Definition>()
  const text = () => assistantText(props.message)

  return (
    <div class="osc-msg osc-assistant">
      <For each={props.message.content}>
        {(part) => (
          <Switch>
            <Match when={part.type === "text" && part}>{(item) => <ctx.ui.Markdown text={item().text} />}</Match>
            <Match when={part.type === "reasoning" && !!part.text.trim() && part}>
              {(item) => (
                <Collapsible name={ctx.t("thinking")} summary="" status="done">
                  <div class="osc-muted">
                    <ctx.ui.Markdown text={item().text} />
                  </div>
                </Collapsible>
              )}
            </Match>
            <Match when={part.type === "tool" && part}>{(item) => <ToolCall tool={item()} />}</Match>
          </Switch>
        )}
      </For>
      <Show when={props.message.error}>{(error) => <div class="osc-error">{error().message}</div>}</Show>
      <Show when={text()}>
        <div class="osc-assistant-actions">
          <ctx.ui.Tooltip value={ctx.t("quote.action")}>
            <ctx.ui.IconButton
              icon="outline-quote"
              label={ctx.t("quote.action")}
              size="small"
              variant="ghost-muted"
              onClick={() => props.onQuote(text())}
            />
          </ctx.ui.Tooltip>
        </div>
      </Show>
    </div>
  )
}

function ToolCall(props: { readonly tool: Tool }) {
  const ctx = usePlugin<Definition>()
  const state = () => props.tool.state
  const status = () => {
    const value = state().status

    return value === "completed" ? "done" : value === "error" ? "failed" : "running"
  }
  const output = () => {
    const current = state()
    const content = current.status === "completed" || current.status === "error" ? (current.content ?? []) : []

    return content.flatMap((item) => (item.type === "text" ? [item.text] : [item.name ?? item.uri])).join("\n")
  }
  const input = () => {
    const value = state().input

    return typeof value === "string" ? value : JSON.stringify(value, null, 2)
  }
  const error = () => {
    const current = state()

    return current.status === "error" ? current.error.message : undefined
  }

  return (
    <Collapsible name={props.tool.name} summary={toolSummary(props.tool)} status={status()}>
      <div class="osc-label">{ctx.t("tool.input")}</div>
      <pre class="osc-pre">{input()}</pre>
      <Show when={output()}>
        <div class="osc-label">{ctx.t("tool.output")}</div>
        <pre class="osc-pre">{output()}</pre>
      </Show>
      <Show when={error()}>{(message) => <div class="osc-error">{message()}</div>}</Show>
    </Collapsible>
  )
}

/** One line that opens to show details: a tool call, a shell command, or reasoning. */
function Collapsible(props: {
  readonly name: string
  readonly summary: string
  readonly status: "running" | "done" | "failed"
  readonly children: import("solid-js").JSX.Element
}) {
  const ctx = usePlugin<Definition>()
  const [open, setOpen] = createSignal(false)

  return (
    <div class="osc-tool">
      <button type="button" class="osc-tool-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="osc-chevron" data-open={open() ? "" : undefined}>
          <ctx.ui.Icon name="chevron-right" size="small" />
        </span>
        <span class="osc-tool-name">{props.name}</span>
        <span class="osc-tool-summary">{props.summary}</span>
        <Switch>
          <Match when={props.status === "running"}>
            <ctx.ui.Loader size="small" />
          </Match>
          <Match when={props.status === "failed"}>
            <span class="osc-error" title={ctx.t("tool.failed")}>
              <ctx.ui.Icon name="circle-x" size="small" />
            </span>
          </Match>
        </Switch>
      </button>
      <Show when={open()}>
        <div class="osc-tool-body">{props.children}</div>
      </Show>
    </div>
  )
}
