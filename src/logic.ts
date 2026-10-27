// Pure logic: no Solid, no host APIs, no network. Everything here is unit tested in logic.test.ts.
//
// nextOrdinal, ownMessages and quoteText are adapted from OpenCode PR #54356
// (packages/gui-extensions/src/side-chat/transcript.ts), MIT licensed.

/** A side chat as the parent session's store keeps it. */
export interface Chat {
  /** The tab id. */
  readonly id: string
  /** The number in the tab's title: the lowest one no open chat uses. */
  readonly ordinal: number
  /** The forked session; missing while the fork is still being made. */
  readonly sessionID?: string
  /** The fork's last inherited message; the tab shows only what follows it. */
  readonly base?: string
  /** When the chat was created, in ms. Cleanup leaves younger chats alone. */
  readonly created: number
}

/** One fork in the app-wide ledger, so cleanup can find forks whose parent's store is gone or never loads. */
export interface LedgerEntry {
  /** The `ServerRef.id` the fork lives on. */
  readonly server: string
  /** The main session it was forked from. */
  readonly parent: string
  /** The forked session. */
  readonly fork: string
  /** The chat (tab) id. */
  readonly chat: string
  /** When the fork was made, in ms. */
  readonly created: number
}

/** The lowest positive number no open side chat uses, so closing "Side chat 1" lets the next one take it again. */
export function nextOrdinal(chats: readonly { readonly ordinal: number }[]): number {
  const used = new Set(chats.map((chat) => chat.ordinal))

  return Array.from({ length: chats.length + 1 }, (_, index) => index + 1).find((ordinal) => !used.has(ordinal)) ?? 1
}

/**
 * The messages a side chat shows: everything after the last one its fork inherited. When `base` is not among the
 * loaded messages, the loaded window starts after it, so all of them belong to the chat.
 */
export function ownMessages<T extends { readonly id: string }>(messages: readonly T[], base: string | undefined): T[] {
  if (!base) return []

  return messages.slice(messages.findIndex((message) => message.id === base) + 1)
}

/** Markdown for a quotation, one `>` per line. Empty for a blank selection. */
export function quoteText(value: string): string {
  const text = value.replace(/\r\n?/g, "\n").trim()

  if (!text) return ""

  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
}

/** Plain text with Windows and old Mac line endings made `\n`, trimmed. */
export function cleanText(value: string | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n").trim()
}

/**
 * The question typed after `/side`. The app passes the text after the command name, already trimmed; this also
 * accepts the whole composer text (`/side …`) and untrimmed text, so the command works whichever the host sends.
 * Returns undefined when there is no question: no text, or only whitespace.
 */
export function parseSideInput(input: string | undefined, name = "side"): string | undefined {
  let text = cleanText(input)
  const prefix = `/${name}`

  if (text === prefix) return undefined
  if (text.startsWith(prefix) && /\s/.test(text.charAt(prefix.length))) text = text.slice(prefix.length).trim()

  return text || undefined
}

/** What the new chat's composer starts with: the quoted selection and a blank line, or nothing. */
export function initialDraft(quote: string): string {
  return quote ? `${quote}\n\n` : ""
}

/** The first message of a chat started with a question: the quoted selection, a blank line, then the question. */
export function firstMessage(quote: string, question: string): string {
  return quote ? `${quote}\n\n${question}` : question
}

/**
 * Where to fork the main session.
 * - `full`: it is idle, so copy the whole history.
 * - `before`: it is mid-turn; fork before the first message of that turn so no half-streamed reply comes along.
 * - `empty`: nothing finished to inherit: no messages, or the first turn is still running.
 */
export type ForkPoint = { readonly kind: "full" } | { readonly kind: "before"; readonly before: string } | { readonly kind: "empty" }

/**
 * Picks the fork point from the main session's messages, oldest first. The list may be only the newest part of the
 * history, as long as it reaches back to the last `idle` marker when there is one. A turn runs from the first message
 * after the last `idle` marker to the next one.
 */
export function forkPoint(messages: readonly { readonly id: string; readonly type: string }[], running: boolean): ForkPoint {
  if (messages.length === 0) return { kind: "empty" }
  if (!running) return { kind: "full" }

  const lastIdle = messages.map((message) => message.type).lastIndexOf("idle")

  if (lastIdle === -1) return { kind: "empty" }

  const next = messages[lastIdle + 1]

  // Running, but the new turn has nothing projected yet: the history up to the marker is complete.
  return next ? { kind: "before", before: next.id } : { kind: "full" }
}

/** "Side: <parent title>", or "Side chat" for an untitled parent. */
export function sideTitle(parentTitle: string | undefined): string {
  const title = (parentTitle ?? "").replace(/\s+/g, " ").trim()

  return title ? `Side: ${title}` : "Side chat"
}

/** What cleanup should do for one parent session. */
export interface Reconciliation {
  /** Forks to delete: chats without a tab, and ledger forks that no chat refers to. */
  readonly deleteForks: readonly string[]
  /** Chats to drop from the parent's store. */
  readonly dropChats: readonly string[]
  /** Tabs to close: those of dropped chats, and those with no chat behind them for at least `grace` ms. */
  readonly closeTabs: readonly string[]
  /** Every stored tab id with no chat behind it now, with when it was first seen so; pass it back next time. */
  readonly dangling: ReadonlyMap<string, number>
  /** Ledger forks to forget (their fork is being deleted, or never belonged to a chat). */
  readonly dropLedger: readonly string[]
  /** Chats with a fork the ledger lacks, to record. */
  readonly adopt: readonly Chat[]
}

/**
 * Compares a parent's stored chats with its restored tabs and the ledger, once all three have loaded. Anything younger
 * than `grace` ms, or being forked in this window (`pending`), is left alone: another window may have just created it
 * and its tab or its store entry may not have synced yet. A tab without a chat has no age of its own, so `dangling`
 * remembers since when each one has been seen without a chat.
 */
export function reconcile(input: {
  readonly chats: readonly Chat[]
  readonly tabs: readonly string[]
  readonly ledger: readonly LedgerEntry[]
  readonly pending: ReadonlySet<string>
  readonly dangling?: ReadonlyMap<string, number>
  readonly now: number
  readonly grace: number
}): Reconciliation {
  const settled = (created: number) => input.now - created >= input.grace
  const tabs = new Set(input.tabs)
  const chatIDs = new Set(input.chats.map((chat) => chat.id))
  const deleteForks = new Set<string>()
  const dropChats = new Set<string>()

  input.chats.forEach((chat) => {
    if (input.pending.has(chat.id) || !settled(chat.created)) return
    // No tab came back for it after a restart, or the fork never finished (its window closed mid-fork).
    if (!tabs.has(chat.id) || !chat.sessionID) {
      dropChats.add(chat.id)
      if (chat.sessionID) deleteForks.add(chat.sessionID)
    }
  })

  const kept = input.chats.filter((chat) => !dropChats.has(chat.id))
  const referenced = new Set(kept.flatMap((chat) => (chat.sessionID ? [chat.sessionID] : [])))
  const dropLedger = new Set<string>()

  input.ledger.forEach((entry) => {
    if (referenced.has(entry.fork)) return
    if (deleteForks.has(entry.fork)) return void dropLedger.add(entry.fork)
    if (input.pending.has(entry.chat) || !settled(entry.created)) return
    // The parent's store lost the chat (the app prunes old sessions' state) or never got it.
    deleteForks.add(entry.fork)
    dropLedger.add(entry.fork)
  })

  const recorded = new Set(input.ledger.map((entry) => entry.fork))
  const dangling = new Map(
    input.tabs.filter((id) => !chatIDs.has(id)).map((id) => [id, input.dangling?.get(id) ?? input.now] as const),
  )

  return {
    deleteForks: [...deleteForks],
    dropChats: [...dropChats],
    closeTabs: input.tabs.filter((id) => {
      const since = dangling.get(id)

      return dropChats.has(id) || (since !== undefined && settled(since))
    }),
    dangling,
    dropLedger: [...dropLedger],
    adopt: kept.filter((chat) => chat.sessionID && !recorded.has(chat.sessionID)),
  }
}

/** The ledger forks to delete when a session is deleted: the forks of that parent on that server. */
export function forksOfParent(ledger: readonly LedgerEntry[], server: string, parent: string): LedgerEntry[] {
  return ledger.filter((entry) => entry.server === server && entry.parent === parent)
}

/** The ledger entry of a fork, when the deleted session was one of ours. */
export function entryOfFork(ledger: readonly LedgerEntry[], server: string, fork: string): LedgerEntry | undefined {
  return ledger.find((entry) => entry.server === server && entry.fork === fork)
}

/** The plugin's options from `opencode.json`, checked. Anything malformed is ignored with a warning. */
export interface SideChatOptions {
  readonly agent?: string
  readonly model?: { readonly providerID: string; readonly id: string }
  readonly warnings: readonly string[]
}

export function parseOptions(options: unknown): SideChatOptions {
  const warnings: string[] = []

  if (options === undefined || options === null) return { warnings }
  if (typeof options !== "object" || Array.isArray(options)) return { warnings: ["options must be an object"] }

  const value = options as Record<string, unknown>
  const agent = typeof value.agent === "string" && value.agent.trim() ? value.agent.trim() : undefined

  if (value.agent !== undefined && !agent) warnings.push("options.agent must be a non-empty string")

  const model = value.model
  let parsed: SideChatOptions["model"]

  if (model !== undefined) {
    const record = typeof model === "object" && model !== null && !Array.isArray(model) ? (model as Record<string, unknown>) : undefined
    const providerID = typeof record?.providerID === "string" ? record.providerID.trim() : ""
    const id = typeof record?.id === "string" ? record.id.trim() : ""

    if (providerID && id) parsed = { providerID, id }
    else warnings.push('options.model must be { "providerID": string, "id": string }')
  }

  return { ...(agent ? { agent } : {}), ...(parsed ? { model: parsed } : {}), warnings }
}

/** The agent an option names, matched by id, then by display name, ignoring case. */
export function matchAgent<T extends { readonly id: string; readonly name: string }>(
  agents: readonly T[],
  wanted: string,
): T | undefined {
  const key = wanted.toLowerCase()

  return agents.find((agent) => agent.id.toLowerCase() === key) ?? agents.find((agent) => agent.name.toLowerCase() === key)
}

/** Enter sends; Shift+Enter is a newline; nothing sends while an IME is composing. */
export function isSubmitKey(event: {
  readonly key: string
  readonly shiftKey: boolean
  readonly isComposing?: boolean
  readonly keyCode?: number
  readonly altKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false
  if (event.isComposing || event.keyCode === 229) return false

  return !event.altKey
}

/** Whether the reader is close enough to the bottom that new output should keep them there. */
export function atBottom(element: { readonly scrollHeight: number; readonly scrollTop: number; readonly clientHeight: number }, slack = 24): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < slack
}

/**
 * The main chat selection to quote: the live one, else the last one if it was lost (for example by clicking the
 * + menu or the composer) less than `window` ms ago.
 */
export function pickQuote(input: {
  readonly live: string
  readonly remembered?: { readonly text: string; readonly lost?: number }
  readonly now: number
  readonly window: number
}): string {
  if (input.live.trim()) return input.live
  const remembered = input.remembered

  if (!remembered?.text.trim() || remembered.lost === undefined) return ""

  return input.now - remembered.lost <= input.window ? remembered.text : ""
}

type ContentPart = { readonly type: string; readonly text?: string }

/** The text parts of an assistant message, for quoting it whole. */
export function assistantText(message: { readonly content?: readonly ContentPart[] }): string {
  return (message.content ?? [])
    .flatMap((part) => (part.type === "text" && part.text?.trim() ? [part.text.trim()] : []))
    .join("\n\n")
}

const summaryKeys = ["description", "command", "filePath", "path", "pattern", "url", "query", "prompt"] as const

/** A one-line summary of a tool call: its most telling string input, shortened. */
export function toolSummary(tool: { readonly name: string; readonly state: { readonly input: unknown } }, max = 80): string {
  const input = tool.state.input

  if (!input || typeof input !== "object") return ""

  const record = input as Record<string, unknown>
  const value = summaryKeys.map((key) => record[key]).find((item): item is string => typeof item === "string" && !!item.trim())

  if (!value) return ""

  const line = value.replace(/\s+/g, " ").trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Message types the transcript draws. The rest (agent and model switches, compaction) stay hidden. */
export const shownTypes = new Set(["user", "assistant", "shell", "synthetic"])

/** Whether the transcript draws a message: the shown types, and the end of a turn that was stopped or failed. */
export function isShown(message: { readonly type: string; readonly outcome?: string }): boolean {
  return shownTypes.has(message.type) || (message.type === "idle" && !!message.outcome && message.outcome !== "succeeded")
}

/** The chat's own messages that the transcript draws. */
export function shownMessages<T extends { readonly id: string; readonly type: string; readonly outcome?: string }>(
  messages: readonly T[],
  base: string | undefined,
): T[] {
  return ownMessages(messages, base).filter(isShown)
}

/** The server's "no such session" error, whatever shape the client gives it. */
export function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false

  const value = error as { _tag?: unknown; name?: unknown; status?: unknown }

  return value._tag === "SessionNotFoundError" || value.name === "SessionNotFoundError" || value.status === 404
}

/** A short reason for a toast. */
export function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message

  return typeof error === "string" && error ? error : undefined
}

/** Form fields the panel can answer inline. External fields (a URL to visit) are answered on their page. */
export type FormAnswer = Readonly<Record<string, string | number | boolean | readonly string[]>>

type FieldLike = {
  readonly key: string
  readonly type: string
  readonly required?: boolean
  readonly hidden?: boolean
  readonly default?: unknown
  readonly when?: readonly { readonly key: string; readonly op: "eq" | "neq"; readonly value: unknown }[]
}

/** Whether a field shows, given the answers so far and its `when` conditions. */
export function fieldShown(field: FieldLike, answers: Readonly<Record<string, unknown>>): boolean {
  if (field.hidden) return false

  return (field.when ?? []).every((rule) => {
    const value = answers[rule.key]
    const equal = Array.isArray(value) ? value.includes(rule.value) : value === rule.value

    return rule.op === "eq" ? equal : !equal
  })
}

/** The starting answers of a form: each field's default, when it has one. */
export function formDefaults(fields: readonly FieldLike[]): Record<string, string | number | boolean | string[]> {
  const answers: Record<string, string | number | boolean | string[]> = {}

  fields.forEach((field) => {
    const value = field.default

    if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) answers[field.key] = value
    if (Array.isArray(value)) answers[field.key] = value.filter((item): item is string => typeof item === "string")
  })

  return answers
}

/**
 * The answer to send for a form, or the keys of required fields still empty. Hidden and inapplicable fields are left
 * out; empty optional fields are left out; numbers are sent as numbers. An answer with nothing in it counts every
 * shown field as missing: the question tool marks no field required, and Skip is the way to answer nothing.
 */
export function formAnswer(
  fields: readonly FieldLike[],
  answers: Readonly<Record<string, unknown>>,
): { readonly answer: FormAnswer; readonly missing: readonly string[] } {
  const answer: Record<string, string | number | boolean | readonly string[]> = {}
  const missing: string[] = []

  fields.forEach((field) => {
    if (field.type === "external" || !fieldShown(field, answers)) return

    const value = answers[field.key]
    const empty =
      value === undefined || value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0)

    if (empty) {
      if (field.required) missing.push(field.key)
      return
    }

    if (field.type === "number" || field.type === "integer") {
      const number = typeof value === "number" ? value : Number(String(value).trim())

      if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) return void missing.push(field.key)
      answer[field.key] = number
      return
    }

    if (field.type === "boolean") return void (answer[field.key] = value === true || value === "true")
    if (field.type === "multiselect") return void (answer[field.key] = (Array.isArray(value) ? value : [value]).map(String))

    answer[field.key] = typeof value === "string" ? value.trim() : String(value)
  })

  if (missing.length === 0 && Object.keys(answer).length === 0)
    return { answer, missing: fields.filter((field) => field.type !== "external" && fieldShown(field, answers)).map((field) => field.key) }

  return { answer, missing }
}
