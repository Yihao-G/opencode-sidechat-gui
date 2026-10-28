// Side chats: forks of the routed session, one side panel tab each.
//
// The fork guard, the abort-after-fork cleanup, `base`, unsent drafts and the store-backed tabs are adapted from
// OpenCode PR #54356 (packages/gui-extensions/src/side-chat/model.ts), MIT licensed.
import { batch, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import { createData } from "@opencode/client/solid"
import { createStore, produce } from "solid-js/store"
import {
  createKeyed,
  type MountedSession,
  type ServerRef,
  type SessionRef,
  type SessionScreen,
  type SetupContext,
} from "@opencode/plugin/gui"
import type { Definition } from "./definition"
import {
  type Chat,
  cleanText,
  entryOfFork,
  errorMessage,
  firstMessage,
  type FormAnswer,
  type ForkPoint,
  forkPoint,
  forksOfParent,
  initialDraft,
  isNotFound,
  type LedgerEntry,
  matchAgent,
  nextOrdinal,
  parseOptions,
  reconcile,
  type SideChatOptions,
  sideTitle,
} from "./logic"

type Client = ServerRef["client"]
type Data = ServerRef["data"]
export type Message = ReturnType<Data["session"]["message"]["list"]>[number]
export type SessionInfo = Awaited<ReturnType<Client["session"]["fork"]>>
export type PermissionDecision = "once" | "always" | "reject"

/** Anything with a live client: a `ServerRef`, or a bare client in tests. Read `client` at each call. */
export interface Api {
  readonly client: Client
}

/** How long a new chat or fork is left alone by cleanup, so another window's tab and store writes can sync. */
export const GRACE_MS = 120_000
/** How long a main chat selection that was lost (by a click or by focusing the composer) still counts as selected. */
export const QUOTE_WINDOW_MS = 60_000

// ---------------------------------------------------------------------------------------------------------------
// Server calls. Each takes an `Api` and reads `api.client` per request, so a restarted server's new client is used.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Reads where to fork `parentID`. Idle: only checks there is any history. Running: reads pages from the newest message
 * back to the last `idle` marker, so the fork can stop before the turn in progress.
 */
export async function readForkPoint(
  api: Api,
  parentID: string,
  running: boolean,
  limit = 100,
): Promise<{ point: ForkPoint; running: boolean }> {
  const active = await api.client.session.active().catch(() => ({}) as Record<string, unknown>)
  const busy = running || !!active[parentID]

  if (!busy) {
    const page = await api.client.message.list({ sessionID: parentID, order: "desc", limit: 1 })

    return { point: forkPoint(page.data, false), running: false }
  }

  const newest: { id: string; type: string }[] = []
  let cursor: string | undefined

  for (let page = 0; page < 10; page++) {
    // A cursor carries its order, and the server rejects both together.
    const result = await api.client.message.list(
      cursor ? { sessionID: parentID, limit, cursor } : { sessionID: parentID, order: "desc", limit },
    )

    newest.push(...result.data)
    if (result.data.some((message) => message.type === "idle")) break
    // The server returns a next cursor even on the last page.
    cursor = result.data.length === limit ? (result.cursor.next ?? undefined) : undefined
    if (!cursor) break
  }

  return { point: forkPoint(newest.reverse(), true), running: true }
}

/** The fork, its last inherited message, and warnings to show (an option that did not apply). */
export interface MadeFork {
  readonly fork: SessionInfo
  readonly base: string
  readonly warnings: readonly { readonly key: string; readonly params?: Record<string, string> }[]
}

/**
 * Forks `parentID` at `point`, names the fork "Side: <parent title>", archives it so it stays out of the session lists
 * (archived sessions still take prompts), applies the agent and model options, and reads its last message as `base`.
 * Deletes the fork again when a later step fails, so a failed start leaves nothing behind.
 */
export async function makeFork(
  api: Api,
  input: {
    readonly parentID: string
    readonly parentTitle: string | undefined
    readonly point: ForkPoint
    readonly directory: string | undefined
    readonly options: SideChatOptions
  },
): Promise<MadeFork> {
  if (input.point.kind === "empty") throw new Error("Nothing to fork yet")

  const fork = await api.client.session.fork({
    sessionID: input.parentID,
    ...(input.point.kind === "before" ? { before: input.point.before } : {}),
  })
  const warnings: { key: string; params?: Record<string, string> }[] = []

  try {
    const title = sideTitle(input.parentTitle)

    // Not fatal: an unarchived fork still works, it only shows in the session list.
    await api.client.session
      .update({ sessionID: fork.id, title, archived: true })
      .catch((cause: unknown) => console.warn("[opencode-sidechat-gui] could not title or archive the fork", cause))

    if (input.options.agent) {
      const agents = await api.client.agent
        .list(input.directory ? { location: { directory: input.directory } } : undefined)
        .then((result) => result.data)
        .catch(() => undefined)
      const agent = agents ? matchAgent(agents, input.options.agent) : undefined

      // The server accepts any agent name, so an unknown one would break every prompt; keep the parent's instead.
      if (!agent) warnings.push({ key: "agent.unknown", params: { agent: input.options.agent } })
      else await api.client.session.switchAgent({ sessionID: fork.id, agent: agent.id }).catch(() => warnings.push({ key: "agent.failed" }))
    }

    if (input.options.model) {
      await api.client.session
        .switchModel({ sessionID: fork.id, model: { providerID: input.options.model.providerID, id: input.options.model.id } })
        .catch(() => warnings.push({ key: "model.failed" }))
    }

    // Forked messages get new ids, so the last inherited one is read from the fork. Agent and model switches come
    // after the copied history and before `base`, so they stay out of the transcript too.
    const page = await api.client.message.list({ sessionID: fork.id, order: "desc", limit: 1 })
    const base = page.data[0]?.id

    if (!base) throw new Error("The fork has no history")

    // The archived, renamed info: the app's session lists filter on `time.archived`, so the synced store must never
    // hold the fork's pre-archive snapshot.
    const info = await api.client.session.get({ sessionID: fork.id }).catch(() => undefined)

    return { fork: info ?? { ...fork, title, time: { ...fork.time, archived: Date.now() } }, base, warnings }
  } catch (cause) {
    await api.client.session.remove({ sessionID: fork.id }).catch(() => undefined)
    throw cause
  }
}

/**
 * Deletes a fork. With `parentID`, first checks the server recorded it as a fork of that parent, so cleanup never
 * deletes a session that is not one of ours. Resolves `gone` when it no longer exists.
 */
export async function deleteFork(api: Api, forkID: string, parentID?: string): Promise<"deleted" | "gone" | "skipped"> {
  try {
    if (parentID) {
      const info = await api.client.session.get({ sessionID: forkID })

      if (info.fork?.sessionID !== parentID || info.parentID) return "skipped"
    }

    await api.client.session.remove({ sessionID: forkID })

    return "deleted"
  } catch (cause) {
    if (isNotFound(cause)) return "gone"
    throw cause
  }
}

/** Whether a session exists: undefined when the server could not say (it is unreachable, for example). */
export async function sessionExists(api: Api, sessionID: string): Promise<boolean | undefined> {
  return api.client.session.get({ sessionID }).then(
    () => true,
    (cause: unknown) => (isNotFound(cause) ? false : undefined),
  )
}

// ---------------------------------------------------------------------------------------------------------------
// The forks' own synced store.
// ---------------------------------------------------------------------------------------------------------------

/** The session a server event is about, if it is about one. */
function eventSession(event: unknown): string | undefined {
  const data = (event as { data?: { sessionID?: unknown; form?: { sessionID?: unknown } } } | undefined)?.data
  const id = data?.sessionID ?? data?.form?.sessionID

  return typeof id === "string" ? id : undefined
}

/**
 * A synced store per server for the forks alone. The app's own store (`ServerRef.data`) runs session retention: only
 * the routed session, open tabs' sessions and the three most recently routed ones keep their transcripts, and every
 * other session's messages are evicted as they arrive. A fork is never routed, so its transcript would vanish. This
 * store is the same `createData` the app uses, fed from the same event connection, but outside that retention and
 * given only the events of the sessions `watch` names (plus those about no session).
 */
export function createForkStores() {
  const owner = getOwner()
  const watched = new Set<string>()
  const stores = new Map<string, { source: Data; store: Data; dispose(): void }>()

  const relevant = (event: unknown) => {
    const id = eventSession(event)

    return id === undefined || watched.has(id)
  }

  onCleanup(() => {
    stores.forEach((entry) => entry.dispose())
    stores.clear()
  })

  return {
    /** Starts following a fork's events. */
    watch: (sessionID: string) => void watched.add(sessionID),
    /** Stops following a fork and drops what the stores hold of it. */
    forget(sessionID: string) {
      watched.delete(sessionID)
      stores.forEach((entry) => entry.store.session.evict(sessionID))
    },
    /** The store for a server; a restarted server, with new data, gets a new one. */
    data(server: ServerRef): Data {
      const source = server.data
      const existing = stores.get(server.id)

      if (existing?.source === source) return existing.store
      existing?.dispose()

      const created = createRoot(
        (dispose) => ({
          dispose,
          store: createData({
            api: () => server.client,
            directory: "",
            initialMessageLimit: () => 40,
            omitToolFileData: true,
            event: {
              on: (type, handler) => source.on(type, (event) => relevant(event) && handler(event)),
              listen: (handler) => source.listen((event) => relevant(event.details) && handler(event)),
            },
            onError: (error) => console.warn("[opencode-sidechat-gui] side chat sync failed", error),
          }),
        }),
        owner,
      )

      stores.set(server.id, { source, ...created })

      return created.store
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The window's side chat model.
// ---------------------------------------------------------------------------------------------------------------

type Phase = { readonly status: "forking" } | { readonly status: "failed"; readonly error?: string }

export interface OpenInput {
  /** Sent as the chat's first message once the fork is ready (`/side <question>`). */
  readonly question?: string
  /** Extra text for the new chat's composer, after the quoted selection. */
  readonly draft?: string
}

/** Side chats per session: forks of the main one, one tab each, deleted when the tab closes. */
export function createSideChat(
  ctx: SetupContext<Definition>,
  input: {
    readonly selection: () => string
    /** The forks' synced store per server; tests may pass the server's own. */
    readonly data?: (server: ServerRef) => Data
  },
) {
  const options = parseOptions(ctx.options)
  const forks = createForkStores()
  // The store a session's side chats read and write: never the app's own, whose retention evicts unrouted sessions.
  const data = (session: SessionRef) => (input.data ? input.data(session.server) : forks.data(session.server))
  const saved = (session: SessionRef) => ctx.stores.chats(session)
  const ledger = ctx.stores.ledger
  // Unsent composer text by tab id. It lives as long as the window, like the other composers' unsaved edits.
  const [drafts, setDrafts] = createStore<Record<string, string>>({})
  // Chats whose fork is being made, or failed to be made, in this window.
  const [phases, setPhases] = createStore<Record<string, Phase>>({})
  // Composer focus requests by tab id, counted so a remounted composer does not take focus again.
  const [focus, setFocus] = createStore<Record<string, number>>({})
  const focused = new Map<string, number>()
  // Sessions being forked, so a repeated shortcut does not start two chats.
  const starting = new Set<string>()
  // First messages and fork points waiting for their chat's fork.
  const questions = new Map<string, string>()
  const points = new Map<string, ForkPoint>()
  // Tabs seen without a chat, by session key, for cleanup.
  const dangling = new Map<string, ReadonlyMap<string, number>>()

  if (options.warnings.length > 0) {
    console.warn("[opencode-sidechat-gui]", options.warnings.join("; "))
    ctx.toast.show({ variant: "error", title: ctx.t("options.invalid", { detail: options.warnings.join("; ") }) })
  }

  const key = (id: string) => `${ctx.id}:${id}`
  const entry = (session: SessionRef, id: string) => saved(session).value?.chats.find((chat) => chat.id === id)

  const toast = (title: string, cause?: unknown, retry?: () => void) => {
    const description = cause === undefined ? undefined : errorMessage(cause)

    ctx.toast.show({
      variant: cause === undefined ? "default" : "error",
      title,
      ...(description ? { description } : {}),
      ...(retry ? { actions: [{ label: ctx.t("retry"), run: retry }] } : {}),
    })
  }

  const clearPhase = (id: string) =>
    setPhases(
      produce((draft) => {
        delete draft[id]
      }),
    )

  const addLedger = (entries: readonly LedgerEntry[]) => {
    if (entries.length === 0) return
    ledger.update((draft) => {
      entries.forEach((item) => {
        if (!draft.forks.some((fork) => fork.server === item.server && fork.fork === item.fork)) draft.forks.push({ ...item })
      })
    })
  }

  const dropLedger = (server: string, forks: readonly string[]) => {
    if (forks.length === 0) return
    ledger.update((draft) => {
      draft.forks = draft.forks.filter((fork) => fork.server !== server || !forks.includes(fork.fork))
    })
  }

  const dropChats = (session: SessionRef, ids: readonly string[]) => {
    if (ids.length === 0) return
    saved(session).update((draft) => {
      draft.chats = draft.chats.filter((chat) => !ids.includes(chat.id))
    })
  }

  // Deletes forks, keeping their ledger entries until the server confirms, so a failed delete is retried later.
  const deleteForks = (server: ServerRef, forks: readonly string[], parentID?: string) =>
    Promise.all(
      forks.map((fork) =>
        deleteFork(server, fork, parentID).then(
          () => dropLedger(server.id, [fork]),
          (cause: unknown) => console.warn("[opencode-sidechat-gui] could not delete fork", fork, cause),
        ),
      ),
    )

  const running = (session: SessionRef, sessionID: string | undefined) =>
    !!sessionID && session.server.data.session.status(sessionID) === "running"

  const requestFocus = (id: string) => setFocus(id, (focus[id] ?? 0) + 1)

  /** Makes the fork of a chat whose tab is open, then sends its first message or focuses its composer. */
  const fork = async (session: SessionRef, id: string) => {
    const server = session.server
    const parentID = session.id
    let point = points.get(id)

    points.delete(id)
    setPhases(id, { status: "forking" })

    try {
      if (!point) {
        const read = await readForkPoint(server, parentID, running(session, parentID))

        if (read.point.kind === "empty") throw new Error(ctx.t(read.running ? "empty.running" : "empty.session"))
        point = read.point
      }

      const made = await makeFork(server, {
        parentID,
        parentTitle: server.data.session.get(parentID)?.title,
        point,
        directory: "directory" in session && typeof session.directory === "string" ? session.directory : session.location?.directory,
        options,
      })

      // The plugin unloaded, or the user closed the tab, while the fork was being made.
      if (ctx.signal.aborted || (saved(session).ready() && !entry(session, id))) {
        clearPhase(id)
        await deleteFork(server, made.fork.id).catch(() => undefined)

        return
      }

      addLedger([{ server: server.id, parent: parentID, fork: made.fork.id, chat: id, created: Date.now() }])
      forks.watch(made.fork.id)
      // The app's store gets the archived snapshot too: its session lists filter on `time.archived`.
      server.data.session.remember(made.fork)
      data(session).session.remember(made.fork)
      batch(() => {
        saved(session).update((draft) => {
          const chat = draft.chats.find((item) => item.id === id)

          if (chat) {
            chat.sessionID = made.fork.id
            chat.base = made.base
          }
        })
        clearPhase(id)
      })
      made.warnings.forEach((warning) => toast(ctx.t(warning.key, warning.params)))

      const question = questions.get(id)

      questions.delete(id)
      if (question) sendTo(session, id, made.fork.id, question)
      else requestFocus(id)
    } catch (cause) {
      if (ctx.signal.aborted) return
      setPhases(id, { status: "failed", ...(errorMessage(cause) ? { error: errorMessage(cause) } : {}) })
      toast(ctx.t("start.failed"), cause, () => void retry(session, id))
    }
  }

  const retry = (session: SessionRef, id: string) => {
    if (!entry(session, id) || phases[id]?.status === "forking") return

    return fork(session, id)
  }

  /**
   * The one way to start a side chat: the + menu, the shortcut and `/side` all come here. Forks the routed session
   * into a new tab; the main chat's selected text becomes a quote at the start of the chat's composer, or of its first
   * message when `question` is given. Never sends anything to the main session.
   */
  const open = async (session: MountedSession | undefined, request: OpenInput = {}) => {
    if (!session?.id) return void toast(ctx.t("need.session"))
    if (ctx.layout.narrow()) return void toast(ctx.t("need.wide"))
    if (session.pending) return void toast(ctx.t("need.ready"))
    if (starting.has(session.key)) return

    starting.add(session.key)
    // Read now: the selection may change while the fork point loads.
    const quote = input.selection()

    try {
      const read = await readForkPoint(session.server, session.id, running(session, session.id)).catch((cause: unknown) => {
        toast(ctx.t("start.failed"), cause, () => void open(ctx.sessions.current(), request))

        return undefined
      })

      if (!read || ctx.signal.aborted) return
      if (read.point.kind === "empty") return void toast(ctx.t(read.running ? "empty.running" : "empty.session"))

      const id = crypto.randomUUID()

      if (request.question) questions.set(id, firstMessage(quote, request.question))
      else setDrafts(id, initialDraft(quote) + (request.draft ?? ""))
      points.set(id, read.point)
      setPhases(id, { status: "forking" })

      // The store write may wait for the store to load; the panel keeps the tab hidden until then.
      batch(() => {
        saved(session).update((draft) => {
          draft.chats.push({ id, ordinal: nextOrdinal(draft.chats), created: Date.now() })
        })
        ctx.layout.open(key(id), session, { tab: "select" })
      })

      await fork(session, id)
    } finally {
      starting.delete(session.key)
    }
  }

  const sendTo = (session: SessionRef, id: string, sessionID: string, text: string) => {
    const value = text.trim()

    if (!value) return

    setDrafts(id, "")
    forks.watch(sessionID)
    void data(session).session.prompt({ sessionID, text: value }).catch((cause: unknown) => {
      // Put the text back unless the user already typed something new.
      setDrafts(id, (current) => (current?.trim() ? current : text))
      toast(ctx.t("send.failed"), cause)
    })
  }

  /** Removes a chat everywhere: its draft and phase, its store entry, its tab, and, unless it is already gone, its fork. */
  const forget = (session: SessionRef, chat: Chat, deleteTheFork: boolean) => {
    setDrafts(
      produce((draft) => {
        delete draft[chat.id]
      }),
    )
    clearPhase(chat.id)
    questions.delete(chat.id)
    points.delete(chat.id)
    dropChats(session, [chat.id])
    if (ctx.layout.state(key(chat.id), session) !== "closed") ctx.layout.close(key(chat.id), session)
    if (!chat.sessionID) return
    if (!input.data) forks.forget(chat.sessionID)
    if (deleteTheFork) void deleteForks(session.server, [chat.sessionID])
    else dropLedger(session.server.id, [chat.sessionID])
  }

  /** A chat's fork was deleted outside the plugin: drop its tab. */
  const forkGone = (session: SessionRef, forkID: string) => {
    const chat = saved(session).value?.chats.find((item) => item.sessionID === forkID)

    if (!chat) return
    forget(session, chat, false)
    toast(ctx.t("fork.gone"))
  }

  /**
   * Cleanup for one parent session, once its chats, its restored tabs and the ledger have loaded: deletes forks whose
   * tab did not come back after a restart, forks the parent's store lost, and drops chats whose fork no longer exists.
   */
  const tidy = (session: MountedSession) => {
    const store = saved(session)

    if (!store.ready() || !ctx.layout.ready() || !session.location) return

    const chats = store.value?.chats ?? []
    const result = reconcile({
      chats,
      tabs: ctx.layout.stored(session),
      ledger: forksOfParent(ledger.value.forks, session.server.id, session.id),
      pending: new Set(Object.keys(phases)),
      ...(dangling.has(session.key) ? { dangling: dangling.get(session.key) } : {}),
      now: Date.now(),
      grace: GRACE_MS,
    })

    dangling.set(session.key, result.dangling)
    addLedger(
      result.adopt.flatMap((chat) =>
        chat.sessionID ? [{ server: session.server.id, parent: session.id, fork: chat.sessionID, chat: chat.id, created: chat.created }] : [],
      ),
    )
    dropChats(session, result.dropChats)
    result.closeTabs.forEach((id) => ctx.layout.close(key(id), session))
    void deleteForks(session.server, result.deleteForks, session.id)

    // A fork deleted outside the plugin while the app was closed.
    const dropped = new Set(result.dropChats)

    chats.forEach((chat) => {
      if (!chat.sessionID || dropped.has(chat.id)) return
      const forkID = chat.sessionID

      void sessionExists(session.server, forkID).then((exists) => {
        if (exists === false) forkGone(session, forkID)
      })
    })
  }

  // Tidies the routed session once everything it needs has loaded, and again after the grace period, when chats that
  // were too young the first time have settled.
  createKeyed(
    () => {
      const session = ctx.sessions.current()

      return session && !session.pending && session.location && ctx.layout.ready() && saved(session).ready() ? session : undefined
    },
    (session) => {
      tidy(session)
      const timer = setTimeout(() => tidy(session), GRACE_MS + 1000)

      onCleanup(() => clearTimeout(timer))
    },
  )

  /** A session was deleted on a server: delete the forks of a deleted parent, and drop the tab of a deleted fork. */
  const deleted = (serverID: string, sessionID: string) => {
    const server = ctx.servers.get(serverID)
    const children = forksOfParent(ledger.value.forks, serverID, sessionID)

    if (server && children.length > 0) void deleteForks(server, children.map((item) => item.fork), sessionID)

    const own = entryOfFork(ledger.value.forks, serverID, sessionID)

    if (own) dropLedger(serverID, [sessionID])

    const parents = ctx.sessions.list().filter((session) => session.server.id === serverID && (!own || session.id === own.parent))

    parents.forEach((session) => forkGone(session, sessionID))
  }

  // One listener per server's synced data; a restarted server gets new data, and a new listener.
  const sources = createMemo(
    () => ctx.servers.list().flatMap((id) => {
      const server = ctx.servers.get(id)

      return server ? [{ id, data: server.data }] : []
    }),
    [],
    { equals: (a, b) => a.length === b.length && a.every((item, index) => item.id === b[index]?.id && item.data === b[index]?.data) },
  )

  createKeyed(sources, (list) => {
    list.forEach((item) => onCleanup(item.data.on("session.deleted", (event) => deleted(item.id, event.data.sessionID))))
  })

  /** Once per connection: forget forks deleted while the app was closed, and delete those whose parent is gone. */
  const sweep = async (server: ServerRef) => {
    const entries = ledger.value.forks.filter((item) => item.server === server.id)
    const parents = [...new Set(entries.map((item) => item.parent))]

    for (const parent of parents) {
      if (ctx.signal.aborted) return
      const exists = await sessionExists(server, parent)

      if (exists === undefined) return
      const forks = entries.filter((item) => item.parent === parent)

      if (!exists) {
        await deleteForks(server, forks.map((item) => item.fork), parent)
        continue
      }

      for (const item of forks) {
        if ((await sessionExists(server, item.fork)) === false) deleted(server.id, item.fork)
      }
    }
  }

  const connected = createMemo(
    () => ctx.servers.list().flatMap((id) => {
      const server = ctx.servers.get(id)

      return server?.connected ? [{ server, client: server.client }] : []
    }),
    [],
    { equals: (a, b) => a.length === b.length && a.every((item, index) => item.client === b[index]?.client) },
  )

  createKeyed(connected, (list) => {
    if (!ledger.ready()) return
    list.forEach((item) => void sweep(item.server))
  })

  return {
    open,
    retry,
    /** The synced store the session's side chats read: messages, pending input, permission requests, questions. */
    data,
    /** Loads a fork's transcript, pending input, permission requests and questions, and follows them from then on. */
    sync(session: SessionRef, sessionID: string) {
      forks.watch(sessionID)
      const store = data(session)

      return Promise.all([
        store.session.message.sync(sessionID),
        store.session.pending.sync(sessionID),
        store.session.permission.sync(sessionID),
        store.session.form.sync(sessionID),
      ]).then(() => undefined)
    },
    saved,
    entry,
    options,
    phase: (id: string): Phase | undefined => phases[id],
    draft: (id: string) => drafts[id] ?? "",
    setDraft: (id: string, value: string) => setDrafts(id, value),
    running,
    requestFocus,
    /** The latest focus request for a tab's composer. */
    focusTick: (id: string) => focus[id] ?? 0,
    /** Claims a focus request once, so only the composer mounted when it was made acts on it. */
    takeFocus(id: string, tick: number) {
      if (tick <= (focused.get(id) ?? 0)) return false
      focused.set(id, tick)

      return true
    },
    /** Sends the chat's draft to its fork. */
    send(session: SessionRef, id: string) {
      const chat = entry(session, id)

      if (!chat?.sessionID || running(session, chat.sessionID)) return
      sendTo(session, id, chat.sessionID, drafts[id] ?? "")
    },
    /** Interrupts the chat's running turn. */
    stop(session: SessionRef, id: string) {
      const chat = entry(session, id)

      if (chat?.sessionID)
        void session.server.client.session.interrupt({ sessionID: chat.sessionID }).catch((cause: unknown) => toast(ctx.t("stop.failed"), cause))
    },
    /** Answers a permission request the chat's fork is waiting on; nothing else shows it, as the fork is never routed. */
    async allow(session: SessionRef, id: string, requestID: string, decision: PermissionDecision) {
      const chat = entry(session, id)

      if (!chat?.sessionID) return
      await data(session).session.permission
        .reply({ sessionID: chat.sessionID, requestID, decision })
        .catch((cause: unknown) => toast(ctx.t("permission.failed"), cause))
    },
    /** Answers a question (form) the chat's fork asked. */
    async answer(session: SessionRef, id: string, formID: string, answer: FormAnswer) {
      const chat = entry(session, id)

      if (!chat?.sessionID) return
      await data(session).session.form
        .reply({ sessionID: chat.sessionID, formID, answer })
        .catch((cause: unknown) => toast(ctx.t("form.failed"), cause))
    },
    /** Dismisses a question, so the fork's turn goes on without an answer. */
    async skip(session: SessionRef, id: string, formID: string) {
      const chat = entry(session, id)

      if (!chat?.sessionID) return
      await data(session).session.form
        .cancel({ sessionID: chat.sessionID, formID })
        .catch((cause: unknown) => toast(ctx.t("form.failed"), cause))
    },
    /**
     * Attaches side chat text to the main chat's next prompt as a quote. It never sends: the user does, from the main
     * composer.
     */
    quote(session: SessionRef, screen: SessionScreen | undefined, id: string, text: string) {
      const chat = entry(session, id)
      const value = cleanText(text)

      if (!chat || !value) return
      if (!screen) return void toast(ctx.t("quote.noComposer"))
      if (!screen.composer.quotable()) return void toast(ctx.t("quote.unavailable"))

      screen.composer.attach({
        type: "quote",
        commentID: crypto.randomUUID(),
        text: value,
        source: { label: ctx.t("quote.label", { number: chat.ordinal }), icon: "speech-bubble", subject: `side chat ${chat.ordinal}` },
      })
      ctx.toast.show({ variant: "success", title: ctx.t("quote.done"), duration: 2000 })
    },
    /** Closing a tab deletes its fork and forgets the chat. */
    remove(session: SessionRef, id: string) {
      const chat = entry(session, id)

      if (chat) forget(session, chat, true)
      else clearPhase(id)
    },
  }
}

export type SideChatModel = ReturnType<typeof createSideChat>
