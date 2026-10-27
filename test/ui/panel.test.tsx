// @vitest-environment happy-dom
import { createRoot } from "solid-js"
import { render } from "solid-js/web"
import { PluginContext } from "#sdk-internal"
import { Command, MenuItem, Panel, type SetupContext } from "@opencode/plugin/gui"
import { afterEach, beforeAll, describe, expect, test } from "vitest"
import type { Definition } from "../../src/definition"
import type { Chat } from "../../src/logic"
import { SideChatPanel } from "../../src/ui/panel"
import { setup as setupPlugin } from "../../src/ui/setup"
import { makeHost, mounted } from "../integration/harness"
import { fakeServer, ui } from "./fixture"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const cleanups: (() => void)[] = []

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.innerHTML = ""
})

async function mount(chat: Partial<Chat> = {}) {
  const fake = fakeServer()
  const host = makeHost({ server: fake.server, ui })
  const session = mounted(fake.server, "ses_main")
  const id = "chat-1"

  host.route(session)
  host.chats(session).set({ chats: [{ id, ordinal: 1, created: Date.now(), sessionID: "ses_fork", base: "base", ...chat }] })
  // Inherited history, up to and including `base`.
  fake.set("messages", "ses_fork", [
    { id: "old", type: "user", text: "inherited question" },
    { id: "base", type: "idle", outcome: "succeeded" },
  ])

  const container = document.createElement("div")

  document.body.append(container)
  const dispose = render(
    () => (
      <PluginContext.Provider value={host.ctx}>
        <SideChatPanel model={host.model} session={session} screen={host.ctx.screen.current()!} id={id} />
      </PluginContext.Provider>
    ),
    container,
  )

  cleanups.push(dispose, host.dispose)
  await flush()

  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name)
  const text = () => container.textContent ?? ""
  const textarea = () => container.querySelector("textarea")!
  const type = (value: string) => {
    textarea().value = value
    textarea().dispatchEvent(new Event("input", { bubbles: true }))
  }
  const key = (init: KeyboardEventInit & { keyCode?: number }) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

    if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode })
    textarea().dispatchEvent(event)
  }

  return { fake, host, session, id, container, button, text, textarea, type, key }
}

describe("the side chat panel", () => {
  test("shows a hint, never the inherited history, until the chat has its own messages", async () => {
    const view = await mount()

    expect(view.text()).toContain("Nothing here reaches the main chat")
    expect(view.text()).not.toContain("inherited question")
  })

  test("draws the chat's own messages, each tool call as one line that opens", async () => {
    const view = await mount()

    view.fake.push("messages", "ses_fork", { id: "u1", type: "user", text: "side question" })
    view.fake.push("messages", "ses_fork", {
      id: "a1",
      type: "assistant",
      content: [
        { type: "tool", id: "t1", name: "read", state: { status: "completed", input: { filePath: "src/a.ts" }, content: [{ type: "text", text: "file body" }] }, time: { created: 1 } },
        { type: "text", text: "side answer" },
      ],
    })
    await flush()

    expect([...view.container.querySelectorAll(".md")].map((item) => item.textContent)).toEqual(["side question", "side answer"])
    expect(view.text()).toContain("src/a.ts")
    expect(view.text()).not.toContain("file body")

    view.container.querySelector<HTMLButtonElement>(".osc-tool-head")!.click()
    await flush()
    expect(view.text()).toContain("file body")
  })

  test("Enter sends; Shift+Enter and IME composition do not", async () => {
    const view = await mount()
    const prompts = () => view.fake.calls.filter((call) => call.name === "prompt")

    view.type("why is this slow?")
    view.key({ key: "Enter", shiftKey: true })
    view.key({ key: "Enter", isComposing: true })
    view.key({ key: "Enter", keyCode: 229 })
    expect(prompts()).toEqual([])

    view.key({ key: "Enter" })
    expect(prompts()).toEqual([{ name: "prompt", input: { sessionID: "ses_fork", text: "why is this slow?" } }])
    await flush()
    expect(view.textarea().value).toBe("")
  })

  test("a draft survives the panel unmounting and mounting again", async () => {
    const view = await mount()

    view.type("half a thought")
    expect(view.host.model.draft(view.id)).toBe("half a thought")
  })

  test("while the fork works, Stop replaces Send and interrupts it", async () => {
    const view = await mount()

    expect(view.button("Send")).toBeTruthy()
    view.fake.set("status", "ses_fork", "running")
    await flush()
    expect(view.button("Send")).toBeUndefined()
    expect(view.text()).toContain("Working…")

    view.button("Stop")!.click()
    expect(view.fake.calls).toContainEqual({ name: "interrupt", input: { sessionID: "ses_fork" } })
  })

  test("a permission request is answered inline", async () => {
    const view = await mount()

    view.fake.set("permissions", "ses_fork", [{ id: "per_1", sessionID: "ses_fork", action: "shell", resources: ["touch probe.txt"] }])
    await flush()
    expect(view.text()).toContain("Allow shell?")
    expect(view.text()).toContain("touch probe.txt")

    view.button("Always allow")!.click()
    expect(view.fake.calls).toContainEqual({
      name: "permission.reply",
      input: { sessionID: "ses_fork", requestID: "per_1", decision: "always" },
    })
  })

  test("a question is answered inline, with a picked option or free text, or skipped", async () => {
    const view = await mount()
    const form = (id: string) => ({
      id,
      sessionID: "ses_fork",
      title: "Questions",
      metadata: { kind: "question" },
      fields: [
        {
          key: "q0",
          title: "Color",
          description: "Pick a color",
          type: "string",
          options: [
            { value: "Red", label: "Red" },
            { value: "Blue", label: "Blue" },
          ],
          custom: true,
        },
      ],
    })

    view.fake.set("forms", "ses_fork", [form("frm_1")])
    await flush()
    expect(view.text()).toContain("Pick a color")

    view.button("Answer")!.click()
    expect(view.fake.calls.some((call) => call.name === "form.reply")).toBe(false)

    view.button("Blue")!.click()
    view.button("Answer")!.click()
    expect(view.fake.calls).toContainEqual({ name: "form.reply", input: { sessionID: "ses_fork", formID: "frm_1", answer: { q0: "Blue" } } })

    view.fake.set("forms", "ses_fork", [form("frm_2")])
    await flush()
    const other = view.container.querySelector<HTMLInputElement>('input[aria-label="Other answer"]')!

    other.value = "Green"
    other.dispatchEvent(new Event("input", { bubbles: true }))
    view.button("Answer")!.click()
    expect(view.fake.calls).toContainEqual({ name: "form.reply", input: { sessionID: "ses_fork", formID: "frm_2", answer: { q0: "Green" } } })

    await flush()
    view.button("Skip")!.click()
    expect(view.fake.calls).toContainEqual({ name: "form.cancel", input: { sessionID: "ses_fork", formID: "frm_2" } })
  })

  test("Quote in main chat attaches the reply to the main composer", async () => {
    const view = await mount()

    view.fake.push("messages", "ses_fork", { id: "a1", type: "assistant", content: [{ type: "text", text: "quote me" }] })
    await flush()
    view.button("Quote in main chat")!.click()
    expect(view.host.attached).toEqual([expect.objectContaining({ type: "quote", text: "quote me" })])
    expect(view.fake.calls.filter((call) => call.name === "prompt")).toEqual([])
  })

  test("a lost server connection shows a banner with Retry", async () => {
    const view = await mount()

    view.fake.setConnected(false)
    await flush()
    expect(view.text()).toContain("Disconnected from the server")
    expect(view.button("Retry")).toBeTruthy()
  })

  test("a fork that failed to start shows the error with Retry and Close", async () => {
    const view = await mount({ sessionID: undefined, base: undefined })

    expect(view.text()).toContain("Couldn’t start a side chat")
    view.button("Retry")!.click()
    await flush()
    await flush()
    expect(view.text()).toContain("server unreachable")
    expect(view.button("Close")).toBeTruthy()
  })
})

describe("the registrations", () => {
  function load() {
    const fake = fakeServer()
    const host = makeHost({ server: fake.server, ui })
    const added: { registry: unknown; item: unknown }[] = []
    const ctx = {
      ...host.ctx,
      add: (registry: unknown, item: unknown) => {
        added.push({ registry, item })

        return () => {}
      },
    } as unknown as SetupContext<Definition>

    createRoot((dispose) => {
      cleanups.push(dispose, host.dispose)
      setupPlugin(ctx)
    })

    const of = <T,>(registry: unknown) =>
      added.filter((entry) => entry.registry === registry).map((entry) => (typeof entry.item === "function" ? entry.item() : entry.item) as T)

    return { fake, host, of }
  }

  test("the shortcut, the + menu item and /side are registered as asked", () => {
    const { of } = load()
    const commands = of<Command>(Command)
    const create = commands.find((command) => command.id === "new")!
    const side = commands.find((command) => command.id === "side")!
    const [item] = of<MenuItem>(MenuItem)
    const [panel] = of<Panel>(Panel)

    expect(create.bind).toBe("mod+alt+n")
    expect(side.slash).toEqual({ name: "side", arguments: true })
    // Enabled with no session routed, so "/side …" in a draft is never sent as a prompt.
    expect(side.enabled).toBeUndefined()
    expect(item).toMatchObject({ menu: "session.panel", id: "new", keybind: "opencode-sidechat-gui.new" })
    expect((item as { primary?: true }).primary).toBeUndefined()
    expect(panel?.transient).toBeUndefined()
    expect(panel?.closed?.({} as never)).toBe(false)
  })

  test("/side with no session routed only says side chats need one", () => {
    const { of, host, fake } = load()
    const side = of<Command>(Command).find((command) => command.id === "side")!

    void side.run("what does this do?")
    expect(host.toasts.map((toast) => toast.title)).toEqual(["Side chats need an open session"])
    expect(fake.calls).toEqual([])
  })
})
