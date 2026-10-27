import { Schema } from "effect"
import { Plugin, Store } from "@opencode/plugin/gui"
import en from "./i18n/en"

const Chat = Schema.Struct({
  // The tab id.
  id: Schema.String,
  // The number in the tab's title; the lowest one no open chat uses.
  ordinal: Schema.Number,
  // The session forked from the main one; missing while the fork is being made.
  sessionID: Schema.optional(Schema.String),
  // The fork's last inherited message; everything up to it stays out of the chat's transcript.
  base: Schema.optional(Schema.String),
  // When the chat was created (ms). Cleanup leaves young chats alone, as another window may still be opening them.
  created: Schema.Number,
})

const Fork = Schema.Struct({
  server: Schema.String,
  parent: Schema.String,
  fork: Schema.String,
  chat: Schema.String,
  created: Schema.Number,
})

export const definition = Plugin.define({
  stores: {
    // Each side chat of a session, kept until its tab closes.
    chats: Store.session(Schema.Struct({ chats: Schema.Array(Chat) }), { chats: [] }),
    // Every fork this plugin made, app-wide. Forks are not child sessions, so nothing else deletes them; this lets
    // cleanup find them when their parent is deleted or the app pruned the parent's stored state.
    ledger: Store.global(Schema.Struct({ forks: Schema.Array(Fork) }), { forks: [] }),
  },
  i18n: { en },
})

export type Definition = typeof definition
