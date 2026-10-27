#!/usr/bin/env bash
# Starts a throwaway OpenCode server whose only model is the scripted fake in fake-llm.mjs, for the integration tests.
# It uses its own HOME, so it never reads or writes your real OpenCode config, sessions or credentials.
#
#   test/integration/serve.sh            # prints the env vars to export, then keeps running
#   OPENCODE_CLI=/path/to/opencode test/integration/serve.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(mktemp -d "${TMPDIR:-/tmp}/sidechat-it.XXXXXX")"
llm_port="${FAKE_LLM_PORT:-4888}"
port="${OPENCODE_PORT:-4777}"
cli="${OPENCODE_CLI:-npx -y @opencode/cli@2.2.0}"

mkdir -p "$root/home/.config/opencode" "$root/work"
cat > "$root/home/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "fake/fake-1",
  "providers": {
    "fake": {
      "name": "Fake",
      "env": ["FAKE_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:${llm_port}/v1" },
      "models": { "fake-1": { "name": "Fake 1" } }
    }
  }
}
EOF
echo "hello" > "$root/work/README.md"

node "$here/fake-llm.mjs" "$llm_port" "$root/fake-llm.log" &
llm=$!
trap 'kill $llm 2>/dev/null || true; kill ${server:-} 2>/dev/null || true' EXIT

cd "$root/work"
FAKE_API_KEY=x HOME="$root/home" XDG_CONFIG_HOME="$root/home/.config" XDG_DATA_HOME="$root/home/.local/share" \
  XDG_STATE_HOME="$root/home/.local/state" XDG_CACHE_HOME="$root/home/.cache" \
  $cli serve --hostname 127.0.0.1 --port "$port" > "$root/server.log" 2>&1 &
server=$!

for _ in $(seq 1 120); do
  grep -q 'server password' "$root/server.log" 2>/dev/null && break
  sleep 0.5
done

password="$(sed -n 's/^server password //p' "$root/server.log")"
if [ -z "$password" ]; then
  cat "$root/server.log"
  exit 1
fi

echo "export OPENCODE_URL=http://127.0.0.1:${port}"
echo "export OPENCODE_PASSWORD=${password}"
echo "export OPENCODE_DIRECTORY=${root}/work"
echo "# logs: $root/server.log $root/fake-llm.log  (Ctrl+C to stop)"
wait $server
