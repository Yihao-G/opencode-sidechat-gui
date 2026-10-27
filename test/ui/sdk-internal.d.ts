// The SDK's context module, aliased in vitest.shared.ts. The app provides this context around every contribution.
declare module "#sdk-internal" {
  import type { Context } from "solid-js"

  export const PluginContext: Context<unknown>
}
