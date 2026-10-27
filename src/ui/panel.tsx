import { createMemo, createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createKeyed, type MountedSession, type SessionScreen, usePlugin } from "@opencode/plugin/gui"
import type { Definition } from "../definition"
import { atBottom, errorMessage, shownMessages } from "../logic"
import type { SideChatModel } from "../model"
import { Composer } from "./composer"
import { FormCard, PermissionCard } from "./requests"
import { Transcript } from "./transcript"

type Load = { readonly status: "loading" | "ready" } | { readonly status: "failed"; readonly error?: string }

/**
 * One side chat tab. `session` is the routed session, a reactive getter: read it where it is used. The fork is never
 * routed, so this panel is the only place that shows what it asks for: permission requests and questions.
 */
export function SideChatPanel(props: {
  readonly model: SideChatModel
  readonly session: MountedSession
  readonly screen: SessionScreen
  readonly id: string
}) {
  const ctx = usePlugin<Definition>()
  const chat = () => props.model.entry(props.session, props.id)
  const phase = () => props.model.phase(props.id)
  const data = () => props.session.server.data
  const forkID = () => chat()?.sessionID
  const running = () => props.model.running(props.session, forkID())
  const connected = () => props.session.server.connected
  const [load, setLoad] = createSignal<Load>({ status: "loading" })
  const [selected, setSelected] = createSignal("")
  let transcript: HTMLDivElement | undefined

  const sync = (id: string) => {
    const store = data()

    setLoad({ status: "loading" })
    Promise.all([
      store.session.message.sync(id),
      store.session.pending.sync(id),
      store.session.permission.sync(id),
      store.session.form.sync(id),
    ]).then(
      () => forkID() === id && setLoad({ status: "ready" }),
      (cause: unknown) => forkID() === id && setLoad({ status: "failed", ...(errorMessage(cause) ? { error: errorMessage(cause) } : {}) }),
    )
  }

  // Loads the fork's transcript and requests, and again once the server reconnects or restarts with new data.
  createKeyed(
    () => {
      const id = forkID()

      return id && connected() ? { id, data: data() } : undefined
    },
    (key) => sync(key.id),
    { equals: (previous, next) => previous.id === next.id && previous.data === next.data },
  )

  const messages = createMemo(() => {
    const current = chat()

    return current?.sessionID ? shownMessages(data().session.message.list(current.sessionID), current.base) : []
  })

  // Sent but not yet delivered: shown faded until the server turns them into messages.
  const queued = createMemo(() => {
    const id = forkID()

    if (!id) return []
    const seen = new Set(messages().map((message) => message.id))

    return data()
      .session.pending.list(id)
      .flatMap((item) => (item.type === "user" && !seen.has(item.id) ? [{ id: item.id, text: item.payload.text }] : []))
  })

  const permissions = () => {
    const id = forkID()

    return id ? data().session.permission.list(id) : []
  }

  const forms = () => {
    const id = forkID()

    return (id && data().session.form.list(id)) || []
  }

  // The selection inside this chat's transcript, for "Quote selection in main chat".
  const selectionChanged = () => {
    const selection = window.getSelection()

    if (!selection || selection.isCollapsed || !transcript) return setSelected("")
    const inside = transcript.contains(selection.anchorNode) && transcript.contains(selection.focusNode)

    setSelected(inside ? selection.toString() : "")
  }

  document.addEventListener("selectionchange", selectionChanged)
  onCleanup(() => document.removeEventListener("selectionchange", selectionChanged))

  const quote = (text: string) => props.model.quote(props.session, props.screen, props.id, text)
  const close = () => ctx.layout.close(`${ctx.id}:${props.id}`, props.session)

  return (
    <div class="osc-root" data-sidechat="">
      <Switch>
        <Match when={!chat()}>
          <Center>
            <ctx.ui.Loader size="normal" />
            <span>{ctx.t("loading")}</span>
          </Center>
        </Match>
        <Match when={phase()?.status === "forking"}>
          <Center>
            <ctx.ui.Loader size="normal" />
            <span>{ctx.t("starting")}</span>
          </Center>
        </Match>
        <Match when={phase()?.status === "failed" || !forkID()}>
          <Center>
            <div class="osc-error">{ctx.t("start.failed")}</div>
            <Show when={(() => { const current = phase(); return current?.status === "failed" ? current.error : undefined })()}>
              {(error) => <div class="osc-muted">{error()}</div>}
            </Show>
            <div class="osc-row">
              <ctx.ui.Button size="small" variant="contrast" icon="refresh" onClick={() => void props.model.retry(props.session, props.id)}>
                {ctx.t("retry")}
              </ctx.ui.Button>
              <ctx.ui.Button size="small" variant="ghost-muted" onClick={close}>
                {ctx.t("close")}
              </ctx.ui.Button>
            </div>
          </Center>
        </Match>
        <Match when={forkID()}>
          {(id) => (
            <>
              <Show when={!connected()}>
                <div class="osc-banner" role="alert">
                  <span>{ctx.t("disconnected")}</span>
                  <ctx.ui.Button size="small" variant="neutral" icon="refresh" onClick={() => sync(id())}>
                    {ctx.t("retry")}
                  </ctx.ui.Button>
                </div>
              </Show>
              <Show when={(() => { const current = load(); return current.status === "failed" ? current : undefined })()}>
                {(failed) => (
                  <div class="osc-banner" role="alert">
                    <span>
                      {ctx.t("load.failed")}
                      {failed().error ? `: ${failed().error}` : ""}
                    </span>
                    <ctx.ui.Button size="small" variant="neutral" icon="refresh" onClick={() => sync(id())}>
                      {ctx.t("retry")}
                    </ctx.ui.Button>
                  </div>
                )}
              </Show>
              <PinnedScroll>
                <div ref={transcript} style={{ display: "contents" }}>
                  <Show
                    when={messages().length > 0 || queued().length > 0 || running()}
                    fallback={
                      <Show when={load().status !== "loading"} fallback={<Center><ctx.ui.Loader size="normal" /></Center>}>
                        <div class="osc-hint">{ctx.t("empty.hint")}</div>
                      </Show>
                    }
                  >
                    <Transcript messages={messages()} queued={queued()} running={running()} onQuote={quote} />
                  </Show>
                </div>
              </PinnedScroll>
              <div class="osc-dock">
                <For each={permissions()}>
                  {(request) => (
                    <PermissionCard request={request} onReply={(decision) => props.model.allow(props.session, props.id, request.id, decision)} />
                  )}
                </For>
                <For each={forms()}>
                  {(form) => (
                    <FormCard
                      form={form}
                      onAnswer={(answer) => props.model.answer(props.session, props.id, form.id, answer)}
                      onSkip={() => props.model.skip(props.session, props.id, form.id)}
                    />
                  )}
                </For>
                <Composer
                  model={props.model}
                  session={props.session}
                  id={props.id}
                  running={running()}
                  selection={selected()}
                  onQuoteSelection={() => quote(selected())}
                />
              </div>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}

function Center(props: { readonly children: JSX.Element }) {
  return <div class="osc-center">{props.children}</div>
}

/** A scroll area that follows new output only while the reader is at the bottom. */
function PinnedScroll(props: { readonly children: JSX.Element }) {
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let pinned = true

  const toBottom = () => {
    if (pinned && scroller) scroller.scrollTop = scroller.scrollHeight
  }

  onMount(() => {
    if (!content) return
    const observer = new ResizeObserver(toBottom)

    observer.observe(content)
    onCleanup(() => observer.disconnect())
    toBottom()
  })

  return (
    <div
      ref={scroller}
      class="osc-scroll"
      onScroll={() => {
        if (scroller) pinned = atBottom(scroller)
      }}
    >
      <div ref={content} class="osc-content">
        {props.children}
      </div>
    </div>
  )
}
