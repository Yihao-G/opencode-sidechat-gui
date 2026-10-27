// Stand-ins for the app's components (ctx.ui) and for a server's synced store, for DOM tests of the panel.
import { createSignal, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ServerRef } from "@opencode/plugin/gui"

type Props = Record<string, unknown> & { children?: JSX.Element }

/** Plain HTML versions of the app's components, so tests can find and press them. */
export const ui = {
  Icon: (props: { name: string }) => <i data-icon={props.name} />,
  Button: (props: Props) => (
    <button type="button" disabled={!!props.disabled || !!props.busy} data-variant={props.variant as string} onClick={props.onClick as never}>
      {props.children}
    </button>
  ),
  IconButton: (props: Props) => (
    <button type="button" aria-label={props.label as string} disabled={!!props.disabled} onClick={props.onClick as never} />
  ),
  Tooltip: (props: Props) => <>{props.children}</>,
  Menu: () => null,
  Loader: () => <span role="progressbar" />,
  Dialog: (props: Props) => <div>{props.children}</div>,
  Switch: (props: Props) => (
    <label>
      <input type="checkbox" checked={!!props.checked} onChange={(event) => (props.onChange as (value: boolean) => void)(event.currentTarget.checked)} />
      {props.label as string}
    </label>
  ),
  TextInput: (props: Props) => (
    <input
      aria-label={props.label as string}
      value={props.value as string}
      onInput={(event) => (props.onInput as (value: string) => void)(event.currentTarget.value)}
    />
  ),
  Keybind: () => null,
  Markdown: (props: { text: string }) => <div class="md">{props.text}</div>,
  Code: (props: { content: string }) => <pre>{props.content}</pre>,
}

type Message = { id: string; type: string; [key: string]: unknown }

/** A server whose synced store the test fills by hand, recording what the panel asks of it. */
export function fakeServer() {
  const [state, setState] = createStore<{
    messages: Record<string, Message[]>
    pending: Record<string, Message[]>
    permissions: Record<string, unknown[]>
    forms: Record<string, unknown[]>
    status: Record<string, "idle" | "running">
  }>({ messages: {}, pending: {}, permissions: {}, forms: {}, status: {} })
  const [connected, setConnected] = createSignal(true)
  const calls: { name: string; input: unknown }[] = []
  const record = (name: string) => (input: unknown) => {
    calls.push({ name, input })

    return Promise.resolve()
  }

  const data = {
    on: () => () => {},
    listen: () => () => {},
    session: {
      get: () => ({ title: "Main" }),
      remember: () => {},
      status: (id: string) => state.status[id] ?? "idle",
      prompt: (input: unknown) => {
        calls.push({ name: "prompt", input })

        return Promise.resolve({})
      },
      message: { list: (id: string) => state.messages[id] ?? [], sync: () => Promise.resolve() },
      pending: { list: (id: string) => state.pending[id] ?? [], sync: () => Promise.resolve() },
      permission: { list: (id: string) => state.permissions[id] ?? [], sync: () => Promise.resolve(), reply: record("permission.reply") },
      form: {
        list: (id: string) => state.forms[id] ?? [],
        sync: () => Promise.resolve(),
        reply: record("form.reply"),
        cancel: record("form.cancel"),
      },
    },
  }

  const client = {
    session: {
      active: () => Promise.resolve({}),
      interrupt: (input: unknown) => {
        calls.push({ name: "interrupt", input })

        return Promise.resolve({ interrupted: true })
      },
      get: () => Promise.resolve({ id: "x" }),
      fork: () => Promise.reject(new Error("server unreachable")),
      remove: record("remove"),
    },
    message: { list: () => Promise.reject(new Error("server unreachable")) },
  }

  const server = {
    id: "sidecar",
    name: "Local",
    url: "http://localhost",
    client,
    data,
    local: true,
    builtin: true,
    compatible: true,
    get connected() {
      return connected()
    },
  } as unknown as ServerRef

  return {
    server,
    calls,
    setConnected,
    set: setState,
    push: (key: "messages" | "pending", id: string, message: Message) =>
      setState(
        produce((draft) => {
          draft[key][id] = [...(draft[key][id] ?? []), message]
        }),
      ),
  }
}
