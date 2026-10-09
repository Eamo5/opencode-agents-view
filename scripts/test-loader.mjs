import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { Host } from "@opencode/plugin/host"

const root = new URL("../", import.meta.url)
const directory = fileURLToPath(root)
const local = Host.resolve({ directory })
assert.equal(local.tui, new URL("tui.js", root).href, "a configured local directory exposes the TUI entrypoint")
assert.equal(local.server, new URL("index.js", root).href, "local server discovery exposes the server entrypoint")
const packaged = Host.resolve({ directory, name: "opencode-agents-view" })
assert.equal(packaged.tui, new URL("dist/tui.js", root).href, "named packages retain their ./tui export")
const server = await Host.load(local.server)
assert.equal(server.default.id, "agents.view")
assert.equal(typeof server.default.setup, "function")
console.log("OpenCode loader passed: local-directory discovery, package exports, server module loading")
