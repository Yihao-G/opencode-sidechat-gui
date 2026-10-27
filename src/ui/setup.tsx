// Registrations: the palette command and shortcut, `/side`, the + menu item, the panel and its styles.
//
// The tab-object cache and the store-backed tab list are adapted from OpenCode PR #54356
// (packages/gui-extensions/src/side-chat/renderer.tsx), MIT licensed.
import { createMemo, Show } from "solid-js"
import { Command, createKeyed, MenuItem, Panel, type PanelTab, type Plugin, type SessionRef, Style } from "@opencode/plugin/gui"
import type { Definition } from "../definition"
import { parseSideInput } from "../logic"
import { createSideChat } from "../model"
import { SideChatPanel } from "./panel"
import { trackSelection } from "./selection"
import { css } from "./styles"

export const setup: Plugin.Setup<Definition> = (ctx) => {
  const selection = trackSelection()
  const model = createSideChat(ctx, { selection: () => selection.take() })
  const sessions = ctx.sessions
  // Changes when a session mounts or unmounts, not on every switch between sessions.
  const mounted = createMemo(() => !!sessions.current())

  // Tab objects per session, reused so strip updates and session switches do not rebuild a trigger.
  const tabs = new Map<string, Map<string, PanelTab>>()

  // Drops the tab objects of sessions whose shell tab closed.
  createKeyed(
    () => [...sessions.list().map((session) => session.key), sessions.current()?.key].join("\u0000"),
    () => {
      const keep = new Set([...sessions.list().map((session) => session.key), sessions.current()?.key])

      tabs.forEach((_cache, key) => {
        if (!keep.has(key)) tabs.delete(key)
      })
    },
  )

  ctx.add(Style, css)

  const start = () => void model.open(sessions.current())

  ctx.add(
    Command,
    (): Command => ({
      id: "new",
      title: ctx.t("command.new"),
      description: ctx.t("command.new.description"),
      keywords: "side chat fork branch btw question",
      group: ctx.t("command.group"),
      section: "session",
      bind: "mod+alt+n",
      enabled: mounted() && !ctx.layout.narrow(),
      run: start,
    }),
  )

  // `/side` stays enabled everywhere: a disabled command would leave "/side …" in a draft's composer to be sent as an
  // ordinary prompt. On Home or a draft it only says side chats need an open session.
  ctx.add(
    Command,
    (): Command => ({
      id: "side",
      title: ctx.t("command.slash"),
      description: ctx.t("command.slash.description"),
      section: "session",
      slash: { name: "side", arguments: true },
      hidden: true,
      run: (input) => {
        const question = parseSideInput(input)

        void model.open(sessions.current(), question ? { question } : {})
      },
    }),
  )

  ctx.add(
    MenuItem,
    (): MenuItem => ({
      menu: "session.panel",
      id: "new",
      title: ctx.t("command.new"),
      icon: "speech-bubble",
      keybind: `${ctx.id}.new`,
      order: 40,
      run: start,
    }),
  )

  const title = (session: SessionRef, id: string) => ctx.t("tab.title", { number: model.entry(session, id)?.ordinal ?? 1 })
  const busy = (session: SessionRef, id: string) =>
    model.phase(id)?.status === "forking" || model.running(session, model.entry(session, id)?.sessionID)

  ctx.add(Panel, {
    id: "chat",
    region: "side",
    // One tab per stored chat. Until the session's store loads its tabs stay listed but hidden, so restore keeps them;
    // afterwards a tab without a stored chat leaves the strip. Not transient: tabs come back after a restart, and
    // cleanup deletes the fork of any chat whose tab did not.
    list: (input) => {
      if (input.open.length === 0) return []

      const saved = model.saved(input.session)
      const session = input.session
      const cache = tabs.get(session.key) ?? new Map<string, PanelTab>()

      tabs.set(session.key, cache)

      return input.open.flatMap((id) => {
        if (saved.ready() && !saved.value?.chats.some((chat) => chat.id === id)) return []

        const existing = cache.get(id)

        if (existing) return [existing]

        const tab: PanelTab = {
          id,
          get title() {
            return title(session, id)
          },
          get hidden() {
            return !saved.ready()
          },
          closable: "hover",
          label: (state) => (
            <span class="osc-tab">
              <ctx.ui.Icon name="speech-bubble" size="small" />
              <span class="osc-tab-title">{title(state.session, id)}</span>
              <Show when={busy(state.session, id)}>
                <ctx.ui.Loader size="small" />
              </Show>
            </span>
          ),
        }

        cache.set(id, tab)

        return [tab]
      })
    },
    render: (props) => <SideChatPanel model={model} session={props.session} screen={props.screen} id={props.tab.id} />,
    focus: (input) => {
      if (!input.restored) model.requestFocus(input.tab.id)
    },
    enter: (input) => model.requestFocus(input.tab.id),
    close: (input) => {
      model.remove(input.session, input.tab.id)
      tabs.get(input.session.key)?.delete(input.tab.id)
    },
    // Closing deletes the fork, so a closed side chat cannot be reopened.
    closed: () => false as const,
  })
}
