# opencode-sidechat-gui

Multi-turn **side chats** for OpenCode Desktop. A side chat is a fork of the session you're in. It opens as a tab in
the right-hand side panel, and you can keep asking follow-ups there. Nothing you say in a side chat reaches the main
session.

> [!NOTE]
> The GUI plugin API (`@opencode/plugin/gui`, the `./gui-experimental` export) is **experimental** and may change
> between OpenCode releases. This plugin is built and tested against `@opencode/plugin` **2.2.0** and the OpenCode
> 2.2.0 server.

## What it does

- **Three ways to open a side chat**, all of which behave the same:
  - **+ menu** in the side panel's tab strip → **New side chat**.
  - **Shortcut** <kbd>Mod</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd>: ⌘⌥N on macOS, Ctrl+Alt+N elsewhere. You can rebind it
    under **Settings → Shortcuts → Session**. (Mod+Shift+N is New Window.)
  - **`/side`** in the main composer:
    - `/side <question>` opens a new side chat and sends `<question>` as its first message.
    - `/side` on its own opens an empty side chat and focuses its composer.
    - Both clear the main composer and never send anything to the main session.
- **Your selection comes along.** Text you selected in the main chat becomes a `> quoted` block at the start of the new
  chat's composer (or of its first message, with `/side <question>`).
- **You can open several side chats per session.** Each is titled "Side chat N", with N the lowest number not in use.
- **A clean fork point.** If the main session is idle, its whole history is forked. If it's mid-reply, the fork stops
  before the turn in progress, so it never inherits a half-streamed answer.
- **The tab shows only the side chat's own messages.** The inherited history is hidden. Replies render as Markdown,
  each tool call is one line you can expand, and an indicator shows while it's working.
- **The composer:** Enter sends (never in the middle of IME composition), Shift+Enter adds a new line, and a Stop
  button replaces Send while the fork is replying. If a send fails, your text goes back into the composer.
- **Permission requests** from the fork appear inline with Allow once / Always allow / Reject.
- **Questions** (forms) from the fork are answered inline: pick an option, type your own answer, or Skip.
- **Quote in main chat:** a button on each reply, plus one that quotes whatever you've selected in the side chat. It
  adds the text as a quote to the main composer and never sends it.
- **Forks stay out of your way.** Each one is renamed "Side: <main title>" and archived, so it doesn't appear in the
  session list. Archived sessions still accept prompts.
- **Closing a tab deletes its fork.**
- **Nothing is left behind** (see [Cleanup](#cleanup)).

## Build

```sh
npm install
npm run build        # writes dist/gui-experimental.cjs
```

`npm run check` runs the typecheck, the build and the tests.

## Install in OpenCode Desktop

Desktop loads GUI plugins **only** from the `plugins` array in your **global** `opencode.json` or `opencode.jsonc`
(`~/.config/opencode/`). It ignores `cli.json`. Add the absolute path to this folder (build it first):

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/opencode-sidechat-gui"
  ]
}
```

To run side chats with another agent (a read-only one, for example) or another model, use the object form with
`options`:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-sidechat-gui",
      "options": {
        "agent": "plan",                                         // optional: agent id or name
        "model": { "providerID": "anthropic", "id": "claude-haiku-5-5" } // optional
      }
    }
  ]
}
```

Without options, a side chat inherits the main session's agent and model. An agent that isn't found shows a warning
and falls back to the main session's agent. **Settings → Extensions → Plugins** lists the plugin as
`opencode-sidechat-gui`, with a switch to turn it off.

## Develop

```sh
npm run dev          # vite build --watch
```

Every rebuild reloads the plugin's GUI in each Desktop window. Changing the plugin's `options` in `opencode.json` also
reloads it.

| Command                    | What it runs                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `npm test`                 | Unit tests of `src/logic.ts`, DOM tests of the panel, and a smoke test that loads the built bundle |
| `npm run test:integration` | `src/model.ts` against a real `opencode serve` with a scripted fake model, see [test/integration](test/integration/README.md) |
| `npm run typecheck`        | `tsc --noEmit`                                                                     |

The code is laid out like this:

```text
src/
├── gui.tsx          ./gui-experimental entry: Plugin.define({ ...definition, setup })
├── definition.ts    stores (per-session chats, app-wide fork ledger) and i18n
├── logic.ts         pure logic: ordinals, base, quoting, /side parsing, fork point, orphan finding, forms, options
├── model.ts         server calls and the side chat model; openSideChat is `open(session, { question?, draft? })`
├── i18n/en.ts       English copy
└── ui/              setup.tsx (registrations), panel, transcript, composer, requests (permissions, questions), styles
```

## How it works

1. **Fork point.** The plugin reads the main session's newest messages. If the session is running, it forks with
   `before` set to the first message after the last `idle` marker, which is where the turn in progress starts.
   - If the main session has no messages, you get a toast: "Send a message in the main chat before starting a side chat".
   - If the very first turn is still running, nothing has finished yet, so you get a toast too.
2. **Fork.** It then:
   - calls `session.fork`.
   - renames and archives the fork with `session.update({ title: "Side: …", archived: true })`.
   - applies the `agent`/`model` options with `session.switchAgent` / `session.switchModel`.
   - reads the fork's last message as `base`. Forked messages get new ids, so `base` comes from the fork.

   Forks have no `parentID`. OpenCode treats `parentID` as "subagent", so the plugin never sets it.
3. **Tab.** The tab opens immediately in a "Starting…" state, so a failed fork can show **Retry** inline as well as in a
   toast. Repeat triggers are ignored while a fork for that session is in progress.
4. **Live data** comes from the app's synced store, `session.server.data`: messages, status, pending input, permissions
   and questions. The plugin doesn't poll.

### Cleanup

Forks aren't child sessions, so OpenCode never deletes them on its own. The plugin tracks every fork in two places: the
parent session's store (`chats`), and an app-wide ledger. It handles each case like this:

| Case                                                            | What happens                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| You close a tab                                                 | Its fork is deleted. A failed delete stays in the ledger and is retried later. |
| App restart with a side chat open                               | The tab is restored (the panel isn't transient) with its transcript.           |
| A chat whose tab didn't come back                               | Its fork is deleted when its session is next opened.                           |
| The parent's stored state was pruned (the app keeps 50 sessions) | The ledger still lists the fork; it's deleted when the parent is next opened.  |
| A fork deleted outside the plugin                               | Its tab is dropped, with a toast.                                              |
| The main session is deleted                                     | Its forks are deleted, live (from the `session.deleted` event).                |
| The main session was deleted while the app was closed           | Its forks are deleted once the app reconnects to the server.                   |

Before any automatic delete, the plugin checks that the server recorded the session as a fork of that parent
(`fork.sessionID`), so cleanup never deletes a session that isn't one of its own. Chats younger than 2 minutes are left
alone, so a tab another window just opened has time to sync.

## Known limitations

- **No app timeline.** The app's session timeline component isn't available to plugins: it isn't on `ctx.ui` or among
  the shared modules. The transcript is simpler, with Markdown replies, one line per tool call (expand it for the raw
  input and output), and no diffs, images or file previews.
- **A plain composer.** The side chat composer is plain text: no `@` mentions, attachments, slash commands or model
  picker. Use the `agent`/`model` options to change how side chats run.
- **What the app does before running `/side`:**
  - It clears the main composer's text; attachments stay.
  - On Home or a draft, the typed text is lost and you get a toast.
  - It applies the composer's chosen agent and model to the main session, the same as for the built-in `/btw`. If you
    changed the picker without sending, the main session switches. No message is sent.
- **Selection quoting** uses the live selection, or one lost in the last 60 seconds (clicking **+** or focusing the
  composer to type `/side` clears it). Selections in text fields and in side chats are ignored.
- **No reopening.** A closed side chat can't be reopened with ⌘⇧T, because closing deletes its fork.
- **Wide windows only.** Side chats need a window at least 768px wide. Below that the app swaps the side panel for narrow-screen views, and the plugin has none.
- **Unvisited parents.** A fork whose parent you never open again, and never delete, stays on the server, archived
  and hidden, until you do one of the two.
- **Closing a window mid-fork.** If a window closes in the middle of a fork (a fraction of a second), that one fork
  can't be recorded and is left behind, archived.
- **A brief flash.** Between `session.fork` and the archive call (milliseconds), the new session briefly exists
  unarchived.
- **Not run in the Desktop app.** The panel's DOM is tested with app-component stand-ins, and the model is tested
  against a real server. Run through the manual checklist in Desktop.

## Credits

The side chat design and parts of the code are adapted from the built-in side chat extension in
[OpenCode PR #54356](https://github.com/anomalyco/opencode/pull/54356): `nextOrdinal`, `ownMessages`, `quoteText` and
their tests, the fork guard and abort cleanup, `base`, drafts, and the store-backed tab list. OpenCode is MIT licensed;
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This plugin adds the following, none of which is in the PR:
- `/side`.
- The mid-reply fork point.
- Renaming and archiving forks.
- Inline answers to questions.
- Restored tabs and cleanup of left-behind forks.
- Agent and model options.
- Tests against a real server.

No license has been chosen for this plugin yet. Add one before publishing it.
