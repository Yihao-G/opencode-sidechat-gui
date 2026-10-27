// A scripted OpenAI-compatible chat completions endpoint, the only model of the integration tests' server.
// The last user message decides the reply:
//   "slow ..."            streams a long reply over ~12s
//   "ask ..."             calls the question tool, then reports the answer it got
//   "run ..."             calls the shell tool (`touch probe-file.txt`), then reports the result
//   anything else         replies with the user texts the model saw, so history can be checked
// Usage: node fake-llm.mjs [port] [log file]
import http from "node:http"
import fs from "node:fs"

const port = Number(process.argv[2] ?? 4888)
const logFile = process.argv[3]
const log = (line) => logFile && fs.appendFileSync(logFile, line + "\n")

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === "string" ? part : (part.text ?? ""))).join("")
      : ""

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

http
  .createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end("{}")
      return
    }
    const input = JSON.parse(body)
    const messages = input.messages ?? []
    const users = messages.filter((m) => m.role === "user").map((m) => textOf(m.content).trim())
    const last = messages.at(-1)
    const lastUser = users.at(-1) ?? ""
    const tools = (input.tools ?? []).map((t) => t.function?.name)
    log(`REQ last=${last?.role} lastUser=${JSON.stringify(lastUser.slice(0, 80))} users=${users.length} tools=${tools.join(",")}`)

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    const id = "chatcmpl-" + Math.random().toString(36).slice(2)
    const send = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      )
    const done = (finish) => {
      send({}, finish)
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    }
    const closed = () => res.destroyed || res.writableEnded

    // A title request has no tools; answer it plainly.
    if (tools.length === 0) {
      send({ role: "assistant", content: "Probe title" })
      return done("stop")
    }

    const toolCall = (name, args) => {
      send({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + Math.random().toString(36).slice(2), type: "function", function: { name, arguments: JSON.stringify(args) } }] })
      done("tool_calls")
    }

    if (last?.role === "tool") {
      send({ role: "assistant", content: `tool result seen: ${textOf(last.content).slice(0, 200)}` })
      return done("stop")
    }

    if (lastUser.startsWith("slow")) {
      send({ role: "assistant", content: "" })
      for (let i = 0; i < 24 && !closed(); i++) {
        send({ content: `chunk${i} ` })
        await sleep(500)
      }
      if (!closed()) done("stop")
      return
    }

    if (lastUser.startsWith("ask")) {
      const name = tools.find((t) => t?.includes("question")) ?? tools[0]
      return toolCall(name, {
        questions: [
          { question: "Pick a color", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] },
        ],
      })
    }

    if (lastUser.startsWith("run")) {
      const name = tools.find((t) => t === "bash" || t === "shell") ?? tools.find((t) => t?.includes("bash")) ?? tools[0]
      return toolCall(name, { command: "touch probe-file.txt", description: "Create a probe file" })
    }

    send({ role: "assistant", content: `I saw ${users.length} user messages: ${users.map((u) => JSON.stringify(u.slice(0, 40))).join(" | ")}` })
    done("stop")
  })
  .listen(port, "127.0.0.1", () => log(`fake llm on ${port}`))
