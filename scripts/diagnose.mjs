#!/usr/bin/env node
// Why doesn't OpenCode Desktop show this plugin? Run on the machine that runs Desktop, from this folder, after
// `npm install && npm run build`:
//
//   npm run diagnose
//
// Desktop loads plugin GUIs only from its own server ("This computer"), the local background service. This prints:
//   1. the global config files that server reads, and their `plugins` entries;
//   2. whether this folder resolves to a GUI bundle the way OpenCode's loader resolves it;
//   3. what the running service itself lists and serves, when one is running.
import { existsSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const id = "opencode-sidechat-gui"
const ok = (text) => console.log(`  ok    ${text}`)
const bad = (text) => console.log(`  FAIL  ${text}`)
const info = (text) => console.log(`        ${text}`)

// JSON with comments and trailing commas, as opencode.jsonc allows.
function parseJsonc(text) {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2)
      if (i === -1) break
      i++
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

const entryTarget = (entry) => (typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.package : undefined)
const samePath = (a, b) => {
  const norm = (value) => path.resolve(value.startsWith("file://") ? fileURLToPath(value) : value).replace(/[\\/]+$/, "")
  const [x, y] = [norm(a), norm(b)]
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y
}

console.log(`\n1. Global config (${process.platform}, the server reads these)`)
const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
const globalDir = process.env.OPENCODE_CONFIG_DIR || path.join(configHome, "opencode")
const systemDir =
  process.platform === "win32"
    ? path.join(process.env.ProgramData || "C:\\ProgramData", "opencode")
    : process.platform === "darwin"
      ? "/Library/Application Support/opencode"
      : "/etc/opencode"
if (process.env.XDG_CONFIG_HOME) info(`XDG_CONFIG_HOME is set: ${process.env.XDG_CONFIG_HOME}`)
if (process.env.OPENCODE_CONFIG_DIR) info(`OPENCODE_CONFIG_DIR is set: ${process.env.OPENCODE_CONFIG_DIR}`)

let configured = false
for (const dir of [systemDir, globalDir]) {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const file = path.join(dir, name)
    if (!existsSync(file)) continue
    let config
    try {
      config = parseJsonc(readFileSync(file, "utf8"))
    } catch (cause) {
      bad(`${file} does not parse: ${cause.message}`)
      continue
    }
    const plugins = Array.isArray(config.plugins) ? config.plugins : []
    info(`${file}: plugins = ${JSON.stringify(plugins.map(entryTarget))}`)
    if ("plugin" in config && !("plugins" in config)) bad(`${file} uses "plugin"; OpenCode 2 reads "plugins"`)
    for (const entry of plugins) {
      const target = entryTarget(entry)
      if (typeof target !== "string") continue
      if (target.startsWith("-") && target.slice(1) === id) bad(`"${target}" turns this plugin off`)
      const local = target.startsWith("file://") || target.startsWith("./") || target.startsWith("../") || path.isAbsolute(target)
      if (local && existsSync(target.startsWith("file://") ? fileURLToPath(target) : path.resolve(dir, target)) && samePath(path.resolve(dir, target), root)) {
        ok(`${file} lists this folder`)
        configured = true
      } else if (/opencode-sidechat-gui/.test(target) && !local) {
        bad(`"${target}" is not an absolute path here, so it is treated as an npm package name and fails`)
      } else if (/opencode-sidechat-gui/.test(target)) {
        bad(`"${target}" does not point at this folder (${root})`)
      }
    }
  }
}
if (!configured) bad(`no global config lists ${root}. Add it to ${path.join(globalDir, "opencode.json")}:  "plugins": [${JSON.stringify(root.replace(/\\/g, "/"))}]`)

console.log("\n2. This folder, as OpenCode's loader resolves it")
let manifest
try {
  manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
} catch {
  bad("package.json is missing or does not parse")
}
if (manifest) {
  manifest.name === id ? ok(`package.json name is "${id}" (the plugin's id)`) : bad(`package.json name is "${manifest.name}", not "${id}"`)
  const target = manifest.exports?.["./gui-experimental"]
  target ? ok(`exports["./gui-experimental"] = ${target}`) : bad('package.json has no exports["./gui-experimental"]')
  const bundle = path.join(root, target ?? "dist/gui-experimental.cjs")
  if (existsSync(bundle)) ok(`${bundle} exists (built ${statSync(bundle).mtime.toLocaleString()})`)
  else bad(`${bundle} is missing: run \`npm run build\`. Without it the plugin is skipped silently.`)
}

console.log('\n3. The running local service ("This computer" in Desktop)')
let Service, OpenCode
try {
  ;({ Service } = await import("@opencode/client/service"))
  ;({ OpenCode } = await import("@opencode/client"))
} catch {
  bad("@opencode/client is not installed here; run `npm install` first")
  process.exit(1)
}
const endpoint = await Service.discover().catch((cause) => {
  bad(`service discovery failed: ${cause?.message ?? cause}`)
  return undefined
})
if (!endpoint) {
  info("No running service found. Start OpenCode Desktop, then run this again.")
  process.exit(0)
}
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const version = await client.server.info().then((value) => value.version, () => undefined)
ok(`found ${endpoint.url}${version ? ` (OpenCode ${version})` : ""}`)

// The server loads plugins in the background; a list read too early is empty.
let listed = []
for (let attempt = 0; attempt < 20 && listed.length === 0; attempt++) {
  listed = await client.plugin.list().then((value) => value.data, () => [])
  if (listed.length === 0) await new Promise((resolve) => setTimeout(resolve, 500))
}
const mine = listed.filter((plugin) => plugin.source.type !== "builtin")
info(`non-built-in plugins: ${mine.length === 0 ? "none" : ""}`)
for (const plugin of mine)
  info(`  ${plugin.id ?? "(no id)"}  ${JSON.stringify(plugin.source)}  features=${Object.keys(plugin.features).join(",") || "none"}  ${plugin.state.status}${plugin.state.status === "failed" ? `: ${plugin.state.error}` : ""}`)

const ours = mine.find((plugin) => plugin.id === id)
if (!ours) bad(`the service does not list ${id}. If step 1 is ok, quit Desktop completely and start it again, then rerun.`)
else if (!ours.features.gui) bad(`${id} is listed without a GUI: the bundle did not resolve (see step 2)`)
else if (ours.state.status !== "active") bad(`${id} failed to load: ${ours.state.error}`)
else {
  const gui = await client.plugin.gui({ id }).then((value) => value.data, (cause) => ({ error: cause?.message ?? String(cause) }))
  if ("error" in gui) bad(`the service lists ${id} but will not serve its bundle: ${gui.error}`)
  else ok(`the service serves the GUI bundle. Desktop should show it under Settings > Extensions > Plugins on "This computer".`)
}
console.log("")
