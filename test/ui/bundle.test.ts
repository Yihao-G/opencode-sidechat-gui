// @vitest-environment happy-dom
// Loads the built bundle the way the app does: one CommonJS file whose requires the app answers with its own modules.
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import * as effect from "effect"
import * as solid from "solid-js"
import * as store from "solid-js/store"
import * as web from "solid-js/web"
import * as sdk from "@opencode/plugin/gui"
import { Command, MenuItem, Panel, Style } from "@opencode/plugin/gui"
import { describe, expect, test } from "vitest"
import { makeHost } from "../integration/harness"
import { fakeServer, ui } from "./fixture"

// The project root: vitest runs from it.
const file = resolve(process.cwd(), "dist/gui-experimental.cjs")
const provided: Record<string, unknown> = {
  effect,
  "solid-js": solid,
  "solid-js/store": store,
  "solid-js/web": web,
  "@opencode/plugin/gui": sdk,
}

describe.skipIf(!existsSync(file))("the built bundle", () => {
  test("requires only modules the app provides, and its setup registers everything", () => {
    const required: string[] = []
    const module = { exports: {} as Record<string, unknown> }
    const load = new Function("require", "module", "exports", readFileSync(file, "utf8"))

    load(
      (name: string) => {
        required.push(name)
        if (!(name in provided)) throw new Error(`the app does not provide ${name}`)

        return provided[name]
      },
      module,
      module.exports,
    )

    const definition = module.exports.default as { setup(ctx: unknown): void; stores: Record<string, { scope: string }> }

    expect(required.sort()).toEqual(["@opencode/plugin/gui", "effect", "solid-js", "solid-js/store", "solid-js/web"])
    expect(Object.fromEntries(Object.entries(definition.stores).map(([key, value]) => [key, value.scope]))).toEqual({
      chats: "session",
      ledger: "global",
    })

    const fake = fakeServer()
    const host = makeHost({ server: fake.server, ui })
    const added: unknown[] = []

    solid.createRoot((dispose) => {
      definition.setup({
        ...host.ctx,
        add: (registry: unknown) => {
          added.push(registry)

          return () => {}
        },
      })
      dispose()
    })
    host.dispose()

    expect(added.filter((item) => item === Command)).toHaveLength(2)
    expect(added.filter((item) => item === MenuItem)).toHaveLength(1)
    expect(added.filter((item) => item === Panel)).toHaveLength(1)
    expect(added.filter((item) => item === Style)).toHaveLength(1)
  })
})
