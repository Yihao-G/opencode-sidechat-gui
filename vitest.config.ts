import { defineConfig, mergeConfig } from "vitest/config"
import { inline, shared } from "./vitest.shared.ts"

// Unit tests of the pure logic, and DOM tests of the panel. No server needed.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ["src/**/*.test.ts", "test/ui/**/*.test.{ts,tsx}"],
      environment: "node",
      server: inline,
    },
  }),
)
