// A stand-in for the desktop app around src/model.ts: the real OpenCode client and the real synced store
// (`createData`, the same one the app's `ServerRef.data` is), wired to a real server's event stream, plus small fakes
// of the host APIs the model uses (stores, layout, sessions, toasts and the main composer).
import { createRoot, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { createData, createSessionRetention } from "@opencode/client/solid"
import type { MountedSession, ServerRef, SetupContext } from "@opencode/plugin/gui"
import type { Definition } from "../../src/definition"
import en from "../../src/i18n/en"
import type { Chat, LedgerEntry } from "../../src/logic"
import { createSideChat, type SideChatModel } from "../../src/model"

export const env = {
  url: process.env.OPENCODE_URL,
  password: process.env.OPENCODE_PASSWORD,
  directory: process.env.OPENCODE_DIRECTORY,
}

export const enabled = !!(env.url && env.directory)

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000, label = "condition"): Promise<T> {
  const end = Date.now() + ms

  while (Date.now() < end) {
    const value = await read()

    if (value) return value
    await sleep(100)
  }

  throw new Error(`Timed out waiting for ${label}`)
}

export function makeClient(): OpenCodeClient {
  const headers: Record<string, string> = {}

  if (env.password) headers.authorization = `Basic ${Buffer.from(`opencode:${env.password}`).toString("base64")}`

  return OpenCode.make({ baseUrl: env.url!, headers })
}

type Handler = (event: { type: string }) => void

/**
 * The server ref the app would hand the plugin: a live client, the synced store, and the event connection. The store
 * is set up as the app sets up its own (packages/app/src/runtime/server/runtime.tsx in OpenCode 2.2.0), including
 * session retention: only the routed session (`routed()`), open tabs' sessions (`tabs()`) and the three most recently
 * routed ones keep their transcripts, and every other session's messages are evicted as they arrive.
 */
export function makeServer(
  client: OpenCodeClient,
  retention: { readonly routed: () => string | undefined; readonly tabs: () => readonly string[] } = {
    routed: () => undefined,
    tabs: () => [],
  },
) {
  const typed = new Map<string, Set<Handler>>()
  const all = new Set<(event: { name: string; details: unknown }) => void>()
  const controller = new AbortController()

  const event = {
    on: (type: string, handler: Handler) => {
      const set = typed.get(type) ?? new Set<Handler>()

      typed.set(type, set)
      set.add(handler)

      return () => void set.delete(handler)
    },
    listen: (handler: (event: { name: string; details: unknown }) => void) => {
      all.add(handler)

      return () => void all.delete(handler)
    },
  }

  void (async () => {
    try {
      for await (const item of client.event.subscribe({ signal: controller.signal })) {
        typed.get(item.type)?.forEach((handler) => handler(item))
        all.forEach((handler) => handler({ name: item.type, details: item }))
      }
    } catch {
      // Ended by close().
    }
  })()

  const data = createRoot(() => {
    const source = createData({
      api: () => client,
      initialMessageLimit: () => 20,
      directory: "",
      omitToolFileData: true,
      // SAFETY: the handlers receive the server's events unchanged, as the app's own wiring passes them.
      event: event as unknown as Parameters<typeof createData>[0]["event"],
      onError: (error) => console.warn("[data]", error),
    })

    createSessionRetention({ session: source.session, current: retention.routed, keep: retention.tabs, limit: 3 })

    return source
  })

  const server = {
    id: "sidecar",
    name: "Local",
    url: env.url!,
    client,
    data,
    local: true,
    builtin: true,
    compatible: true,
    connected: true,
  } satisfies ServerRef

  return { server, close: () => controller.abort() }
}

/** A Persisted store held in memory: always loaded, so writes apply at once, as the desktop's do once loaded. */
function persisted<T extends object>(initial: T) {
  const [value, setValue] = createStore<{ current: T }>({ current: structuredClone(initial) })

  return {
    get value() {
      return value.current
    },
    ready: () => true,
    update: (mutate: (draft: T) => undefined) => setValue(produce((draft) => void mutate(draft.current as T))),
    set: (next: T) => setValue("current", structuredClone(next)),
  }
}

export interface Host {
  readonly ctx: SetupContext<Definition>
  readonly model: SideChatModel
  readonly toasts: { title: string; variant?: string }[]
  readonly attached: unknown[]
  /** Tab ids per session key, as the layout would store them. */
  readonly strips: Map<string, string[]>
  readonly chats: (session: MountedSession) => ReturnType<typeof persisted<{ chats: Chat[] }>>
  readonly ledger: ReturnType<typeof persisted<{ forks: LedgerEntry[] }>>
  route(session: MountedSession | undefined): void
  dispose(): void
}

const translate = (key: string, params?: Record<string, string | number | boolean>) =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name] ?? ""))

/**
 * A window: a fresh model over shared stores. Pass the stores of an earlier window to simulate an app restart, where
 * stored chats and tabs come back but nothing in memory does.
 */
export function makeHost(input: {
  readonly server: ServerRef
  readonly options?: Record<string, unknown>
  readonly ui?: unknown
  /** The store side chats use, instead of the plugin's own per-server store. */
  readonly data?: (server: ServerRef) => ServerRef["data"]
  readonly composer?: { quotable(): boolean; attach(part: unknown): void }
  readonly stores?: { chats: Map<string, ReturnType<typeof persisted<{ chats: Chat[] }>>>; ledger: ReturnType<typeof persisted<{ forks: LedgerEntry[] }>> }
  readonly strips?: Map<string, string[]>
}): Host & { stores: NonNullable<typeof input.stores> } {
  const toasts: { title: string; variant?: string }[] = []
  const attached: unknown[] = []
  const stores = input.stores ?? { chats: new Map(), ledger: persisted<{ forks: LedgerEntry[] }>({ forks: [] }) }
  const strips = input.strips ?? new Map<string, string[]>()
  const [current, setCurrent] = createSignal<MountedSession | undefined>(undefined)
  const [layoutTick, setLayoutTick] = createSignal(0)
  const controller = new AbortController()

  const chats = (session: { key: string }) => {
    const existing = stores.chats.get(session.key)

    if (existing) return existing
    const created = persisted<{ chats: Chat[] }>({ chats: [] })

    stores.chats.set(session.key, created)

    return created
  }

  const strip = (session: { key: string }) => {
    layoutTick()

    return strips.get(session.key) ?? []
  }

  const composer = input.composer ?? {
    quotable: () => true,
    attach: (part: unknown) => void attached.push(part),
  }

  const ctx = {
    id: "opencode-sidechat-gui",
    options: input.options ?? {},
    signal: controller.signal,
    t: translate,
    plural: translate,
    toast: {
      show: (options: { title: string; variant?: string }) => {
        toasts.push(options)

        return { dismiss() {} }
      },
    },
    stores: { chats, ledger: stores.ledger },
    layout: {
      ready: () => true,
      narrow: () => false,
      stored: (session: { key: string }) => strip(session),
      state: (key: string, session: { key: string }) => (strip(session).includes(key.split(":").pop()!) ? "open" : "closed"),
      open: (key: string, session: { key: string }) => {
        const id = key.split(":").pop()!

        strips.set(session.key, [...(strips.get(session.key) ?? []).filter((item) => item !== id), id])
        setLayoutTick((tick) => tick + 1)
      },
      close: (key: string, session: { key: string }) => {
        const id = key.split(":").pop()!

        strips.set(session.key, (strips.get(session.key) ?? []).filter((item) => item !== id))
        setLayoutTick((tick) => tick + 1)
      },
    },
    sessions: { current, list: () => (current() ? [current()!] : []) },
    servers: { list: () => [input.server.id], get: (id: string) => (id === input.server.id ? input.server : undefined) },
    screen: { current: () => (current() ? { composer } : undefined) },
    ui: input.ui,
    system: { openExternal: () => {}, copy: async () => {} },
  }

  let dispose = () => {}
  const model = createRoot((release) => {
    dispose = release

    // SAFETY: the model reads only the members faked above.
    return createSideChat(ctx as unknown as SetupContext<Definition>, {
      selection: () => "",
      ...(input.data ? { data: input.data } : {}),
    })
  })

  return {
    // SAFETY: as above.
    ctx: ctx as unknown as SetupContext<Definition>,
    model,
    toasts,
    attached,
    strips,
    stores,
    chats: chats as Host["chats"],
    ledger: stores.ledger,
    route: setCurrent,
    dispose: () => {
      controller.abort()
      dispose()
    },
  }
}

/** The routed session as the app would describe it. */
export function mounted(server: ServerRef, id: string, directory = env.directory ?? "/workspace"): MountedSession {
  return {
    key: `${server.id}\n${id}`,
    id,
    tab: `tab-${id}`,
    server,
    pending: false,
    location: { directory },
    visit: {},
    project: undefined,
    listedProject: undefined,
    directory,
    local: true,
    background: [],
  } as MountedSession
}
