# Integration tests against a real OpenCode server

`sidechat.test.ts` drives `src/model.ts`, the part of the plugin that talks to the server, against a real
`opencode serve` with the real synced store (`createData` from `@opencode/client/solid`, which is what the app hands a
plugin as `ServerRef.data`). The host APIs around it (stores, layout, toasts, the main composer) are small fakes in
`harness.ts`.

The server's only model is `fake-llm.mjs`, a scripted OpenAI-compatible endpoint, so no API key or network is needed and
replies are predictable:

| Prompt starts with | The fake model                                                                  |
| ------------------ | ------------------------------------------------------------------------------- |
| `slow`             | streams a reply over about 12 seconds (for mid-reply forks and Stop)             |
| `ask`              | calls the `question` tool, then reports the answer it got                        |
| `run`              | calls the `shell` tool (`touch probe-file.txt`), then reports the result         |
| anything else      | replies `I saw N user messages: …`, listing what it saw, so history is checkable |

## Run

```sh
# Terminal 1: a throwaway server with its own HOME (your real config and sessions are never touched).
test/integration/serve.sh
# It prints three export lines. Terminal 2:
export OPENCODE_URL=… OPENCODE_PASSWORD=… OPENCODE_DIRECTORY=…
npm run test:integration
```

`serve.sh` runs `npx -y @opencode/cli@2.2.0` by default; set `OPENCODE_CLI` to use an installed binary, and
`OPENCODE_PORT` / `FAKE_LLM_PORT` to change ports. Without `OPENCODE_URL` the suite is skipped.
