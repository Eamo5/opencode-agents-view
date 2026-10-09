import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const require = createRequire(import.meta.url)
const path = require.resolve("@opencode/cli/package.json")
const cli = JSON.parse(await readFile(path, "utf8"))
const binary = resolve(dirname(path), cli.bin.opencode)
const directory = fileURLToPath(new URL("../", import.meta.url))
const content = JSON.parse(process.env.OPENCODE_CLI_CONFIG_CONTENT || "{}")
content.session = { new_location: "inherit", ...content.session }
content.plugins = [...(content.plugins ?? []), { package: directory }]
const child = spawn(binary, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, OPENCODE_AGENTS_VIEW: "1", OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify(content) },
})
child.on("error", (error) => { console.error(error.message); process.exitCode = 1 })
child.on("exit", (code) => { process.exitCode = code ?? 1 })
