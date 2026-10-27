import { onCleanup } from "solid-js"
import { pickQuote, quoteText } from "../logic"
import { QUOTE_WINDOW_MS } from "../model"

/** Text fields, and side chat panels: a selection there is not main chat text. */
const excluded = "textarea, input, [contenteditable], [data-sidechat]"

const elementOf = (node: Node | null | undefined) => (node instanceof Element ? node : node?.parentElement)

/** The selected text, unless it is in a text field or a side chat. */
function liveSelection(): string {
  const selection = window.getSelection()

  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return ""

  const inside = [selection.anchorNode, selection.focusNode, selection.getRangeAt(0).commonAncestorContainer].some(
    (node) => !!elementOf(node)?.closest(excluded),
  )

  return inside ? "" : selection.toString()
}

/**
 * Follows the main chat selection, so a side chat can start with it as a quote. Clicking the + menu or focusing the
 * composer to type `/side` clears the selection first, so a selection lost a moment ago still counts.
 * Call under an owner: the listener ends with it.
 */
export function trackSelection() {
  let remembered: { text: string; lost?: number } | undefined

  const changed = () => {
    const text = liveSelection()

    if (text.trim()) remembered = { text }
    else if (remembered && remembered.lost === undefined) remembered = { ...remembered, lost: Date.now() }
  }

  document.addEventListener("selectionchange", changed)
  onCleanup(() => document.removeEventListener("selectionchange", changed))

  return {
    /** The selection as a Markdown quote, or ""; a remembered selection is used once. */
    take(): string {
      const text = pickQuote({
        live: liveSelection(),
        ...(remembered ? { remembered } : {}),
        now: Date.now(),
        window: QUOTE_WINDOW_MS,
      })

      remembered = undefined

      return quoteText(text)
    },
  }
}
