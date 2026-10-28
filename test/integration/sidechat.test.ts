// Drives src/model.ts against a real OpenCode server whose model is the scripted fake in fake-llm.mjs.
// Start one with test/integration/serve.sh, export the variables it prints, then run `npm run test:integration`.
// Skipped when OPENCODE_URL is not set.
import { createSignal } from "solid-js"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { OpenCodeClient } from "@opencode/client"
import type { ServerRef } from "@opencode/plugin/gui"
import { isNotFound, ownMessages, shownMessages } from "../../src/logic"
import { readForkPoint } from "../../src/model"
import { enabled, env, makeClient, makeHost, makeServer, mounted, until } from "./harness"

describe.skipIf(!enabled)("side chats against a real OpenCode server", () => {
  let client: OpenCodeClient
  let server: ServerRef
  let close = () => {}

  beforeAll(() => {
    client = makeClient()
    ;({ server, close } = makeServer(client))
  })

  afterAll(() => close())

  const busy = async (id: string) => !!(await client.session.active())[id]
  const idle = (id: string) => until(async () => !(await busy(id)), 45_000, `${id} idle`)
  const messages = async (id: string) => (await client.message.list({ sessionID: id, order: "asc", limit: 200 })).data
  const users = async (id: string) =>
    (await messages(id)).flatMap((message) => (message.type === "user" ? [message.text] : []))
  const replies = async (id: string) =>
    (await messages(id)).flatMap((message) =>
      message.type === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
    )
  const gone = (id: string) =>
    until(
      () => client.session.get({ sessionID: id }).then(() => false, (cause: unknown) => isNotFound(cause)),
      30_000,
      `${id} deleted`,
    )

  const parent = async (title: string, text: string | undefined = "hello main", permissions = false) => {
    const session = await client.session.create({ location: { directory: env.directory! }, title })

    if (permissions) await client.session.update({ sessionID: session.id, permissions: [{ action: "*", resource: "*", effect: "ask" }] })
    if (text) {
      await client.session.prompt({ sessionID: session.id, text })
      await idle(session.id)
    }

    return session
  }

  const open = async (title: string, options?: Record<string, unknown>, text?: string, permissions = false) => {
    const main = await parent(title, text, permissions)
    const host = makeHost({ server, ...(options ? { options } : {}) })
    const session = mounted(server, main.id)

    host.route(session)

    return { main, host, session, chats: () => host.chats(session).value.chats }
  }

  test("a side chat is a titled, archived fork in its own tab, and the main chat gets nothing", async () => {
    const { main, host, session, chats } = await open("Main A")
    const before = await messages(main.id)

    await host.model.open(session)

    const chat = chats()[0]!

    expect(chat.sessionID).toBeTruthy()
    expect(chat.base).toBeTruthy()
    expect(chat.ordinal).toBe(1)
    expect(host.strips.get(session.key)).toEqual([chat.id])

    const fork = await client.session.get({ sessionID: chat.sessionID! })

    expect(fork.title).toBe("Side: Main A")
    expect(typeof fork.time.archived).toBe("number")
    expect(fork.parentID).toBeUndefined()
    expect(fork.fork?.sessionID).toBe(main.id)
    expect(host.ledger.value.forks).toContainEqual(expect.objectContaining({ parent: main.id, fork: fork.id, chat: chat.id }))

    // The app's session lists leave archived sessions out: the sidebar filters the synced store like this.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const sidebar = server.data.session.list().filter((item) => !item.parentID && !item.time?.archived)

    expect(sidebar.some((item) => item.id === fork.id)).toBe(false)
    const unarchived = await client.session.list({ limit: 200, archived: false })

    expect(unarchived.data.some((item) => item.id === fork.id)).toBe(false)
    expect(unarchived.data.some((item) => item.id === main.id)).toBe(true)

    // The fork inherits the whole history; the tab shows none of it.
    expect(await users(fork.id)).toEqual(["hello main"])
    expect(ownMessages(await messages(fork.id), chat.base)).toEqual([])
    expect(await messages(main.id)).toHaveLength(before.length)
    expect(host.model.focusTick(chat.id)).toBeGreaterThan(0)
    host.dispose()
  })

  test("two follow-ups that depend on each other, and the main chat never sees them", async () => {
    const { main, host, session, chats } = await open("Main B")
    const before = await messages(main.id)

    await host.model.open(session)
    const chat = chats()[0]!

    host.model.setDraft(chat.id, "side first")
    host.model.send(session, chat.id)
    expect(host.model.draft(chat.id)).toBe("")
    await until(() => busy(chat.sessionID!).then((value) => !value && users(chat.sessionID!).then((list) => list.length === 2)), 30_000, "first reply")
    await idle(chat.sessionID!)

    host.model.setDraft(chat.id, "side second")
    host.model.send(session, chat.id)
    await until(async () => (await replies(chat.sessionID!)).length === 3, 30_000, "second reply")

    // The fake model lists the user messages it saw: the main chat's history, then both side questions.
    expect((await replies(chat.sessionID!)).at(-1)).toBe('I saw 3 user messages: "hello main" | "side first" | "side second"')
    expect(await messages(main.id)).toHaveLength(before.length)

    // What the tab draws, from the synced store the app uses.
    await until(() => shownMessages(host.model.data(session).session.message.list(chat.sessionID!), chat.base).length === 4, 10_000, "store sync")
    expect(shownMessages(host.model.data(session).session.message.list(chat.sessionID!), chat.base).map((message) => message.type)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ])
    host.dispose()
  })

  test("the transcript survives the app's session retention: the posted text shows at once, then the reply", async () => {
    // As in the app: the routed main session and its tab keep their transcripts; the unrouted fork does not.
    const [routed, setRouted] = createSignal<string>()
    const retained = makeServer(client, { routed, tabs: () => (routed() ? [routed()!] : []) })
    const main = await parent("Main retention")

    setRouted(main.id)
    const host = makeHost({ server: retained.server })
    const session = mounted(retained.server, main.id)

    host.route(session)
    await host.model.open(session)
    const chat = host.chats(session).value.chats[0]!
    const store = host.model.data(session)
    const drawn = () => [
      ...shownMessages(store.session.message.list(chat.sessionID!), chat.base).map((message) =>
        message.type === "user" ? `user:${message.text}` : message.type,
      ),
      ...store.session.pending.list(chat.sessionID!).flatMap((item) => (item.type === "user" ? [`pending:${item.payload.text}`] : [])),
    ]

    await host.model.sync(session, chat.sessionID!)
    host.model.setDraft(chat.id, "slow side question")
    host.model.send(session, chat.id)
    // The posted text shows before the reply, while the fork works.
    await until(() => drawn().some((item) => item.endsWith(":slow side question")), 5_000, "posted text drawn")
    await until(() => host.model.running(session, chat.sessionID), 10_000, "running")
    await until(() => drawn().includes("assistant"), 15_000, "streaming reply drawn")
    host.model.stop(session, chat.id)
    await idle(chat.sessionID!)
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Still there once the turn ends and the app's retention has run again.
    expect(drawn()).toEqual(["user:slow side question", "assistant", "idle"])
    expect(retained.server.data.session.message.list(chat.sessionID!)).toEqual([])
    host.dispose()
    retained.close()
  })

  test("/side <question> sends the question as the side chat's first message", async () => {
    const { main, host, session, chats } = await open("Main C")

    await host.model.open(session, { question: "what does this function do?" })
    const chat = chats()[0]!

    await until(async () => (await replies(chat.sessionID!)).length === 2, 30_000, "answer")
    expect(await users(chat.sessionID!)).toEqual(["hello main", "what does this function do?"])
    expect(await users(main.id)).toEqual(["hello main"])
    expect(host.model.draft(chat.id)).toBe("")
    host.dispose()
  })

  test("repeat triggers while a fork is in progress start one chat; numbers reuse the lowest free one", async () => {
    const { host, session, chats } = await open("Main D")

    await Promise.all([host.model.open(session), host.model.open(session), host.model.open(session)])
    expect(chats()).toHaveLength(1)

    await host.model.open(session)
    await host.model.open(session)
    expect(chats().map((chat) => chat.ordinal)).toEqual([1, 2, 3])

    const second = chats()[1]!

    host.model.remove(session, second.id)
    await gone(second.sessionID!)
    await host.model.open(session)
    expect(chats().map((chat) => chat.ordinal).sort()).toEqual([1, 2, 3])
    host.dispose()
  })

  test("an empty main chat refuses with a toast and forks nothing", async () => {
    const { host, session, chats } = await open("Main E", undefined, "")

    await host.model.open(session)
    expect(chats()).toHaveLength(0)
    expect(host.toasts.map((toast) => toast.title)).toContain("Send a message in the main chat before starting a side chat")
    host.dispose()
  })

  test("a side chat started mid-reply leaves the turn in progress out", async () => {
    const { main, host, session, chats } = await open("Main F")

    await client.session.prompt({ sessionID: main.id, text: "slow reply please" })
    await until(() => busy(main.id), 10_000, "main running")
    await host.model.open(session)

    const chat = chats()[0]!

    expect(await users(chat.sessionID!)).toEqual(["hello main"])
    expect((await messages(chat.sessionID!)).at(-1)?.type).toBe("idle")
    await client.session.interrupt({ sessionID: main.id })
    host.dispose()
  })

  test("the fork point is found across pages of a long history", async () => {
    const main = await parent("Main F2", "turn one")

    await client.session.prompt({ sessionID: main.id, text: "turn two" })
    await idle(main.id)
    await client.session.prompt({ sessionID: main.id, text: "slow turn three" })
    await until(() => busy(main.id), 10_000, "main running")

    const third = (await messages(main.id)).find((message) => message.type === "user" && message.text === "slow turn three")
    const read = await readForkPoint(server, main.id, false, 1)

    expect(read).toEqual({ running: true, point: { kind: "before", before: third?.id } })
    await client.session.interrupt({ sessionID: main.id })
  })

  test("a first turn still running has nothing finished to fork", async () => {
    const { main, host, session, chats } = await open("Main G", undefined, "")

    await client.session.prompt({ sessionID: main.id, text: "slow first reply" })
    await until(() => busy(main.id), 10_000, "main running")
    await host.model.open(session)
    expect(chats()).toHaveLength(0)
    expect(host.toasts.map((toast) => toast.title)).toContain("Wait for the main chat’s first reply before starting a side chat")
    await client.session.interrupt({ sessionID: main.id })
    host.dispose()
  })

  test("a permission request in the side chat is answered inline", async () => {
    const { main, host, session, chats } = await open("Main H", undefined, "hi", true)

    await host.model.open(session)
    const chat = chats()[0]!

    host.model.setDraft(chat.id, "run something")
    host.model.send(session, chat.id)
    await host.model.sync(session, chat.sessionID!)
    const request = await until(() => host.model.data(session).session.permission.list(chat.sessionID!)[0], 30_000, "permission request")

    expect(request.action).toBe("shell")
    await host.model.allow(session, chat.id, request.id, "once")
    await until(async () => (await replies(chat.sessionID!)).some((text) => text.startsWith("tool result seen")), 30_000, "tool result")
    expect(await client.permission.list({ sessionID: main.id })).toEqual([])
    host.dispose()
  })

  test("a question in the side chat is answered inline", async () => {
    const { host, session, chats } = await open("Main I")

    await host.model.open(session)
    const chat = chats()[0]!

    host.model.setDraft(chat.id, "ask me a question")
    host.model.send(session, chat.id)
    await host.model.sync(session, chat.sessionID!)
    const form = await until(() => host.model.data(session).session.form.list(chat.sessionID!)?.[0], 30_000, "form")

    await host.model.answer(session, chat.id, form.id, { [form.fields[0].key]: "Blue" })
    await until(async () => (await replies(chat.sessionID!)).some((text) => text.includes('"Pick a color"="Blue"')), 30_000, "answer used")
    host.dispose()
  })

  test("Stop interrupts the side chat's reply", async () => {
    const { host, session, chats } = await open("Main J")

    await host.model.open(session)
    const chat = chats()[0]!

    host.model.setDraft(chat.id, "slow side reply")
    host.model.send(session, chat.id)
    await until(() => host.model.running(session, chat.sessionID), 15_000, "store sees running")
    host.model.stop(session, chat.id)
    await idle(chat.sessionID!)
    expect((await messages(chat.sessionID!)).at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
    host.dispose()
  })

  test("Quote in main chat attaches a quote to the main composer and sends nothing", async () => {
    const { main, host, session, chats } = await open("Main K")

    await host.model.open(session)
    const chat = chats()[0]!

    host.model.quote(session, host.ctx.screen.current(), chat.id, "  the answer\r\nis 42  ")
    expect(host.attached).toEqual([
      expect.objectContaining({ type: "quote", text: "the answer\nis 42", source: expect.objectContaining({ subject: "side chat 1" }) }),
    ])
    expect(await users(main.id)).toEqual(["hello main"])
    host.dispose()
  })

  test("closing a tab deletes its fork", async () => {
    const { host, session, chats } = await open("Main L")

    await host.model.open(session)
    const chat = chats()[0]!

    host.model.remove(session, chat.id)
    await gone(chat.sessionID!)
    expect(chats()).toEqual([])
    await until(() => host.ledger.value.forks.every((item) => item.fork !== chat.sessionID), 5_000, "ledger")
    host.dispose()
  })

  test("after a restart, a restored tab keeps its fork and a chat without its tab loses it", async () => {
    const { host, session, chats } = await open("Main M")

    await host.model.open(session)
    await host.model.open(session)
    const [kept, lost] = chats()

    if (!kept || !lost) throw new Error("expected two chats")

    host.dispose()
    // Old enough for cleanup, and only the first tab came back.
    host.chats(session).set({ chats: chats().map((chat) => ({ ...chat, created: Date.now() - 10 * 60_000 })) })
    const strips = new Map([[session.key, [kept.id]]])
    const restarted = makeHost({ server, stores: host.stores, strips })

    restarted.route(session)
    await gone(lost.sessionID!)
    expect(restarted.chats(session).value.chats.map((chat) => chat.id)).toEqual([kept.id])
    expect((await client.session.get({ sessionID: kept.sessionID! })).id).toBe(kept.sessionID)
    restarted.dispose()
  })

  test("a fork deleted outside the plugin drops its tab", async () => {
    const { host, session, chats } = await open("Main N")

    await host.model.open(session)
    const chat = chats()[0]!

    await client.session.remove({ sessionID: chat.sessionID! })
    await until(() => chats().length === 0, 15_000, "chat dropped")
    expect(host.strips.get(session.key)).toEqual([])
    expect(host.toasts.map((toast) => toast.title)).toContain("This side chat’s session no longer exists")
    host.dispose()
  })

  test("deleting the main session deletes its side chats", async () => {
    const { main, host, session, chats } = await open("Main O")

    await host.model.open(session)
    await host.model.open(session)
    const forks = chats().map((chat) => chat.sessionID!)

    await client.session.remove({ sessionID: main.id })
    await Promise.all(forks.map(gone))
    await until(() => host.ledger.value.forks.every((item) => !forks.includes(item.fork)), 10_000, "ledger")
    host.dispose()
  })

  test("a main session deleted while the app was closed has its side chats deleted on the next connection", async () => {
    const { main, host, session, chats } = await open("Main P")

    await host.model.open(session)
    const fork = chats()[0]!.sessionID!

    host.dispose()
    await client.session.remove({ sessionID: main.id })
    const next = makeHost({ server, stores: host.stores, strips: host.strips })

    await gone(fork)
    await until(() => next.ledger.value.forks.every((item) => item.fork !== fork), 10_000, "ledger")
    next.dispose()
  })

  test("options.agent and options.model apply to the fork; an unknown agent warns and inherits", async () => {
    const plan = await open("Main Q", { agent: "plan", model: { providerID: "fake", id: "fake-1" } })

    await plan.host.model.open(plan.session)
    const fork = await client.session.get({ sessionID: plan.chats()[0]!.sessionID! })

    expect(fork.agent).toBe("plan")
    expect(fork.model?.id).toBe("fake-1")
    plan.host.dispose()

    const unknown = await open("Main R", { agent: "no-such-agent" })
    const parentAgent = (await client.session.get({ sessionID: unknown.main.id })).agent

    await unknown.host.model.open(unknown.session)
    const inherited = await client.session.get({ sessionID: unknown.chats()[0]!.sessionID! })

    expect(inherited.agent).toBe(parentAgent)
    expect(unknown.host.toasts.map((toast) => toast.title)).toContain(
      "Side chat agent “no-such-agent” was not found; using the main chat’s agent",
    )
    unknown.host.dispose()
  })
})
