import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import type { ViteUserConfig } from "vitest/config"

const path = (file: string) => fileURLToPath(new URL(file, import.meta.url))

// Shared by both test configs. Kept apart from vite.config.ts so tests do not run the GUI bundle preset. Solid's
// browser build is used, so effects and memos run under Node as they do in the app's windows.
export const shared: ViteUserConfig = {
  plugins: [solid()],
  resolve: {
    alias: [
      { find: /^solid-js$/, replacement: path("./node_modules/solid-js/dist/solid.js") },
      { find: /^solid-js\/store$/, replacement: path("./node_modules/solid-js/store/dist/store.js") },
      { find: /^solid-js\/web$/, replacement: path("./node_modules/solid-js/web/dist/web.js") },
      // The SDK's own context, which the app provides around contributions; the UI tests provide it instead.
      { find: /^#sdk-internal$/, replacement: path("./node_modules/@opencode/plugin/dist/gui/internal.js") },
    ],
  },
}

export const inline = { deps: { inline: [/@opencode\//, /solid-js/] } }
