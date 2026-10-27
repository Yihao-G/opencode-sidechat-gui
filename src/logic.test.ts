import { describe, expect, test } from "vitest"
import {
  assistantText,
  atBottom,
  type Chat,
  cleanText,
  entryOfFork,
  fieldShown,
  firstMessage,
  forkPoint,
  forksOfParent,
  formAnswer,
  formDefaults,
  initialDraft,
  isNotFound,
  isSubmitKey,
  type LedgerEntry,
  matchAgent,
  nextOrdinal,
  ownMessages,
  parseOptions,
  parseSideInput,
  pickQuote,
  quoteText,
  reconcile,
  shownMessages,
  sideTitle,
  toolSummary,
} from "./logic"

// Ported from OpenCode PR #54356, packages/gui-extensions/src/side-chat/transcript.test.ts.
describe("ported from PR #54356", () => {
  test("a new side chat takes the lowest number no open chat uses", () => {
    expect(nextOrdinal([])).toBe(1)
    expect(nextOrdinal([{ ordinal: 1 }, { ordinal: 2 }])).toBe(3)
    expect(nextOrdinal([{ ordinal: 2 }, { ordinal: 3 }])).toBe(1)
    expect(nextOrdinal([{ ordinal: 1 }, { ordinal: 3 }])).toBe(2)
  })

  test("a side chat shows only what follows the last inherited message", () => {
    const messages = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]

    expect(ownMessages(messages, "b")).toEqual([{ id: "c" }, { id: "d" }])
    expect(ownMessages(messages, "d")).toEqual([])
    // A loaded window that starts after the inherited history holds only the chat's own messages.
    expect(ownMessages([{ id: "x" }, { id: "y" }], "b")).toEqual([{ id: "x" }, { id: "y" }])
  })

  test("quotes every line, keeping blank ones, and ignores a blank selection", () => {
    expect(quoteText("one\r\n\r\ntwo\n")).toBe("> one\n>\n> two")
    expect(quoteText("  \n ")).toBe("")
  })
})

describe("ownMessages and shownMessages", () => {
  test("a chat without a base yet shows nothing, not the whole inherited history", () => {
    expect(ownMessages([{ id: "a" }], undefined)).toEqual([])
  })

  test("only user, assistant, shell and synthetic messages, and stopped turns, are drawn", () => {
    const messages = [
      { id: "base", type: "idle", outcome: "succeeded" },
      { id: "s1", type: "agent-switched" },
      { id: "u1", type: "user" },
      { id: "a1", type: "assistant" },
      { id: "i1", type: "idle", outcome: "succeeded" },
      { id: "sh", type: "shell" },
      { id: "i2", type: "idle", outcome: "interrupted" },
    ]

    expect(shownMessages(messages, "base").map((message) => message.id)).toEqual(["u1", "a1", "sh", "i2"])
  })
})

describe("parseSideInput", () => {
  test("no text means no question", () => {
    expect(parseSideInput(undefined)).toBeUndefined()
    expect(parseSideInput("")).toBeUndefined()
  })

  test("whitespace only means no question", () => {
    expect(parseSideInput("   ")).toBeUndefined()
    expect(parseSideInput("\n\t \r\n")).toBeUndefined()
  })

  test("multi-line text keeps its lines", () => {
    expect(parseSideInput("why does\nthis fail?\n\nsee above")).toBe("why does\nthis fail?\n\nsee above")
    expect(parseSideInput("line one\r\nline two")).toBe("line one\nline two")
  })

  test("leading and trailing spaces are dropped", () => {
    expect(parseSideInput("   what does this function do?  ")).toBe("what does this function do?")
    expect(parseSideInput("\n\n  indented question")).toBe("indented question")
  })

  test("the whole composer text works too", () => {
    expect(parseSideInput("/side what does this do?")).toBe("what does this do?")
    expect(parseSideInput("/side")).toBeUndefined()
    expect(parseSideInput("/side   ")).toBeUndefined()
    expect(parseSideInput("/side\nmulti\nline")).toBe("multi\nline")
  })

  test("text that only starts like the command is a question", () => {
    expect(parseSideInput("/sidebar is broken")).toBe("/sidebar is broken")
    expect(parseSideInput("sidecar?")).toBe("sidecar?")
  })
})

describe("drafts and first messages", () => {
  test("a selection becomes a quote at the start", () => {
    expect(initialDraft("")).toBe("")
    expect(initialDraft("> a")).toBe("> a\n\n")
    expect(firstMessage("", "why?")).toBe("why?")
    expect(firstMessage("> a", "why?")).toBe("> a\n\nwhy?")
  })

  test("cleanText normalizes line endings", () => {
    expect(cleanText(" a\r\nb\rc ")).toBe("a\nb\nc")
    expect(cleanText(undefined)).toBe("")
  })
})

describe("forkPoint", () => {
  const history = [
    { id: "u1", type: "user" },
    { id: "a1", type: "assistant" },
    { id: "i1", type: "idle" },
  ]

  test("an empty session has nothing to inherit", () => {
    expect(forkPoint([], false)).toEqual({ kind: "empty" })
    expect(forkPoint([], true)).toEqual({ kind: "empty" })
  })

  test("an idle session forks its whole history", () => {
    expect(forkPoint(history, false)).toEqual({ kind: "full" })
    // Idle, even if the last turn failed without an idle marker.
    expect(forkPoint([{ id: "u1", type: "user" }], false)).toEqual({ kind: "full" })
  })

  test("a running session forks before the first message of the turn in progress", () => {
    const running = [...history, { id: "m2", type: "model-switched" }, { id: "u2", type: "user" }, { id: "a2", type: "assistant" }]

    expect(forkPoint(running, true)).toEqual({ kind: "before", before: "m2" })
    expect(forkPoint([...history, { id: "u2", type: "user" }], true)).toEqual({ kind: "before", before: "u2" })
  })

  test("a running session with nothing projected after its last marker forks it all", () => {
    expect(forkPoint(history, true)).toEqual({ kind: "full" })
  })

  test("a first turn still running has nothing finished to inherit", () => {
    expect(forkPoint([{ id: "u1", type: "user" }, { id: "a1", type: "assistant" }], true)).toEqual({ kind: "empty" })
  })

  test("only the newest page is needed, back to the last marker", () => {
    const tail = [{ id: "i9", type: "idle" }, { id: "u10", type: "user" }]

    expect(forkPoint(tail, true)).toEqual({ kind: "before", before: "u10" })
  })
})

describe("sideTitle", () => {
  test("names the fork after its parent", () => {
    expect(sideTitle("Fix the parser")).toBe("Side: Fix the parser")
    expect(sideTitle("  many\n  spaces  ")).toBe("Side: many spaces")
    expect(sideTitle(undefined)).toBe("Side chat")
    expect(sideTitle("   ")).toBe("Side chat")
  })
})

describe("reconcile: finding orphaned forks", () => {
  const now = 1_000_000
  const grace = 120_000
  const old = now - grace - 1
  const chat = (id: string, sessionID: string | undefined, created = old): Chat => ({
    id,
    ordinal: 1,
    created,
    ...(sessionID ? { sessionID, base: "b" } : {}),
  })
  const entry = (fork: string, chatID: string, created = old): LedgerEntry => ({
    server: "sidecar",
    parent: "p",
    fork,
    chat: chatID,
    created,
  })
  const base = { pending: new Set<string>(), now, grace }

  test("a chat whose tab came back is kept", () => {
    const result = reconcile({ ...base, chats: [chat("c1", "f1")], tabs: ["c1"], ledger: [entry("f1", "c1")] })

    expect(result).toMatchObject({ deleteForks: [], dropChats: [], closeTabs: [], dropLedger: [], adopt: [] })
  })

  test("a chat whose tab did not come back after a restart loses its fork", () => {
    const result = reconcile({ ...base, chats: [chat("c1", "f1")], tabs: [], ledger: [entry("f1", "c1")] })

    expect(result.deleteForks).toEqual(["f1"])
    expect(result.dropChats).toEqual(["c1"])
    expect(result.dropLedger).toEqual(["f1"])
  })

  test("young and pending chats are left alone, so another window's new chat survives", () => {
    const young = reconcile({ ...base, chats: [chat("c1", "f1", now - 1000)], tabs: [], ledger: [] })
    const pending = reconcile({ ...base, pending: new Set(["c2"]), chats: [chat("c2", undefined)], tabs: [], ledger: [] })

    expect(young.deleteForks).toEqual([])
    expect(young.dropChats).toEqual([])
    expect(pending.dropChats).toEqual([])
  })

  test("a chat whose fork never finished is dropped, tab and all", () => {
    const result = reconcile({ ...base, chats: [chat("c1", undefined)], tabs: ["c1"], ledger: [] })

    expect(result.dropChats).toEqual(["c1"])
    expect(result.closeTabs).toEqual(["c1"])
    expect(result.deleteForks).toEqual([])
  })

  test("a ledger fork that no chat refers to is deleted (the parent's store was pruned)", () => {
    const result = reconcile({ ...base, chats: [], tabs: [], ledger: [entry("f9", "gone")] })

    expect(result.deleteForks).toEqual(["f9"])
    expect(result.dropLedger).toEqual(["f9"])
  })

  test("a young ledger fork without a chat is left alone", () => {
    const result = reconcile({ ...base, chats: [], tabs: [], ledger: [entry("f9", "c9", now - 10)] })

    expect(result.deleteForks).toEqual([])
  })

  test("a chat the ledger lacks is recorded", () => {
    const result = reconcile({ ...base, chats: [chat("c1", "f1")], tabs: ["c1"], ledger: [] })

    expect(result.adopt.map((item) => item.id)).toEqual(["c1"])
  })

  test("a tab without a chat closes only after it has dangled for the grace period", () => {
    const first = reconcile({ ...base, chats: [], tabs: ["t1"], ledger: [] })

    expect(first.closeTabs).toEqual([])
    expect(first.dangling.get("t1")).toBe(now)

    const later = reconcile({ ...base, chats: [], tabs: ["t1"], ledger: [], dangling: first.dangling, now: now + grace })

    expect(later.closeTabs).toEqual(["t1"])
  })

  test("a dangling tab whose chat arrives stops dangling", () => {
    const first = reconcile({ ...base, chats: [], tabs: ["t1"], ledger: [] })
    const later = reconcile({ ...base, chats: [chat("t1", "f1")], tabs: ["t1"], ledger: [entry("f1", "t1")], dangling: first.dangling, now: now + grace })

    expect(later.closeTabs).toEqual([])
    expect(later.dangling.size).toBe(0)
  })

  test("a deleted parent's forks are found by server and parent", () => {
    const ledger = [entry("f1", "c1"), { ...entry("f2", "c2"), parent: "q" }, { ...entry("f3", "c3"), server: "other" }]

    expect(forksOfParent(ledger, "sidecar", "p").map((item) => item.fork)).toEqual(["f1"])
    expect(entryOfFork(ledger, "sidecar", "f2")?.chat).toBe("c2")
    expect(entryOfFork(ledger, "sidecar", "f3")).toBeUndefined()
  })
})

describe("parseOptions", () => {
  test("no options inherit everything", () => {
    expect(parseOptions(undefined)).toEqual({ warnings: [] })
    expect(parseOptions({})).toEqual({ warnings: [] })
  })

  test("reads an agent and a model", () => {
    expect(parseOptions({ agent: " plan ", model: { providerID: "anthropic", id: "claude-haiku-5-5" } })).toEqual({
      agent: "plan",
      model: { providerID: "anthropic", id: "claude-haiku-5-5" },
      warnings: [],
    })
  })

  test("malformed values are ignored with a warning", () => {
    const result = parseOptions({ agent: 3, model: "anthropic/claude" })

    expect(result.agent).toBeUndefined()
    expect(result.model).toBeUndefined()
    expect(result.warnings).toHaveLength(2)
    expect(parseOptions([]).warnings).toHaveLength(1)
  })
})

describe("matchAgent", () => {
  const agents = [
    { id: "build", name: "Build" },
    { id: "plan", name: "Plan" },
  ]

  test("matches by id, then by name, ignoring case", () => {
    expect(matchAgent(agents, "plan")?.id).toBe("plan")
    expect(matchAgent(agents, "Plan")?.id).toBe("plan")
    expect(matchAgent(agents, "nope")).toBeUndefined()
  })
})

describe("isSubmitKey", () => {
  const key = (init: Partial<Parameters<typeof isSubmitKey>[0]>) => isSubmitKey({ key: "Enter", shiftKey: false, ...init })

  test("Enter sends and Shift+Enter does not", () => {
    expect(key({})).toBe(true)
    expect(key({ shiftKey: true })).toBe(false)
    expect(key({ key: "a" })).toBe(false)
  })

  test("nothing sends during IME composition", () => {
    expect(key({ isComposing: true })).toBe(false)
    expect(key({ keyCode: 229 })).toBe(false)
  })
})

describe("atBottom", () => {
  test("within the slack counts as the bottom", () => {
    expect(atBottom({ scrollHeight: 1000, scrollTop: 590, clientHeight: 400 })).toBe(true)
    expect(atBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(false)
  })
})

describe("pickQuote", () => {
  test("prefers the live selection", () => {
    expect(pickQuote({ live: "live", remembered: { text: "old", lost: 0 }, now: 10, window: 60_000 })).toBe("live")
  })

  test("uses a selection lost a moment ago, not one lost long ago", () => {
    expect(pickQuote({ live: "", remembered: { text: "old", lost: 1000 }, now: 5000, window: 60_000 })).toBe("old")
    expect(pickQuote({ live: "", remembered: { text: "old", lost: 1000 }, now: 100_000, window: 60_000 })).toBe("")
    expect(pickQuote({ live: "", remembered: { text: "old" }, now: 5000, window: 60_000 })).toBe("")
    expect(pickQuote({ live: "", now: 5000, window: 60_000 })).toBe("")
  })
})

describe("transcript helpers", () => {
  test("assistantText joins the text parts", () => {
    expect(
      assistantText({
        content: [
          { type: "reasoning", text: "hmm" },
          { type: "text", text: " one " },
          { type: "tool" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\n\ntwo")
  })

  test("toolSummary picks the most telling input", () => {
    expect(toolSummary({ name: "shell", state: { input: { command: "ls  -la", description: "List files" } } })).toBe("List files")
    expect(toolSummary({ name: "read", state: { input: { filePath: "src/a.ts" } } })).toBe("src/a.ts")
    expect(toolSummary({ name: "x", state: { input: "{partial" } })).toBe("")
    expect(toolSummary({ name: "x", state: { input: { command: "a".repeat(100) } } }, 10)).toBe("aaaaaaaaa…")
  })

  test("isNotFound recognizes the server's error", () => {
    expect(isNotFound({ _tag: "SessionNotFoundError" })).toBe(true)
    expect(isNotFound({ name: "SessionNotFoundError" })).toBe(true)
    expect(isNotFound({ status: 404 })).toBe(true)
    expect(isNotFound(new Error("network"))).toBe(false)
    expect(isNotFound(undefined)).toBe(false)
  })
})

describe("forms", () => {
  const fields = [
    { key: "q0", type: "string", required: true, options: [{ value: "Red" }] },
    { key: "n", type: "integer" },
    { key: "many", type: "multiselect", default: ["a"] },
    { key: "ok", type: "boolean", default: false },
    { key: "why", type: "string", when: [{ key: "q0", op: "eq" as const, value: "Other" }] },
    { key: "site", type: "external" },
  ]

  test("defaults fill the starting answers", () => {
    expect(formDefaults(fields)).toEqual({ many: ["a"], ok: false })
  })

  test("conditional fields follow their rules", () => {
    expect(fieldShown(fields[4]!, { q0: "Other" })).toBe(true)
    expect(fieldShown(fields[4]!, { q0: "Red" })).toBe(false)
    expect(fieldShown({ key: "h", type: "string", hidden: true }, {})).toBe(false)
  })

  test("builds the answer and reports missing required fields", () => {
    expect(formAnswer(fields, { many: ["a"], ok: false }).missing).toEqual(["q0"])

    const { answer, missing } = formAnswer(fields, { q0: " Blue ", n: "3", many: ["a", "b"], ok: true, why: "skip me" })

    expect(missing).toEqual([])
    expect(answer).toEqual({ q0: "Blue", n: 3, many: ["a", "b"], ok: true })
  })

  test("an answer with nothing in it is never sent, even when no field is required", () => {
    const question = [{ key: "q0", type: "string" }, { key: "site", type: "external" }]

    expect(formAnswer(question, {})).toEqual({ answer: {}, missing: ["q0"] })
    expect(formAnswer(question, { q0: "  " }).missing).toEqual(["q0"])
    expect(formAnswer(question, { q0: "Red" })).toEqual({ answer: { q0: "Red" }, missing: [] })
  })

  test("a non-integer for an integer field is missing", () => {
    expect(formAnswer(fields, { q0: "x", n: "2.5" }).missing).toEqual(["n"])
  })
})
