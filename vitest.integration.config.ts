import { defineConfig, mergeConfig } from "vitest/config"
import { inline, shared } from "./vitest.shared.ts"

// Runs src/model.ts against a real OpenCode server (see test/integration/README.md).
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ["test/integration/**/*.test.ts"],
      environment: "node",
      testTimeout: 90_000,
      hookTimeout: 90_000,
      fileParallelism: false,
      server: inline,
    },
  }),
)
