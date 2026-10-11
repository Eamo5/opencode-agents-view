import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Host } from "@opencode/plugin/host"

// Use OpenCode's Arborist dependency, rather than the npm executable's resolver.
// They can differ: npm CLI accepted 0.1.2 while OpenCode failed with ERESOLVE.
const require = createRequire(import.meta.resolve("@opencode/util/npm"))
const { Arborist } = require("@npmcli/arborist")
const exec = promisify(execFile)
const root = fileURLToPath(new URL("../", import.meta.url))
const temporary = await realpath(await mkdtemp(join(tmpdir(), "agents-package-")))
try {
  const { stdout } = await exec(process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--json", "--pack-destination", temporary], { cwd: root })
  // Lifecycle output may precede npm's JSON result.
  const packed = JSON.parse(stdout.slice(stdout.indexOf("[")))[0]
  const directory = join(temporary, "install")
  await mkdir(directory)
  const tree = await new Arborist({
    path: directory, binLinks: true, progress: false, savePrefix: "", ignoreScripts: true, audit: false,
  }).reify({ add: [join(temporary, packed.filename)], save: true, saveType: "prod", audit: false })
  const installed = tree.children.get("opencode-agents-view")
  assert.ok(installed, "tarball installs without checkout dependencies")
  assert.equal(installed.version, packed.version)
  for (const node of tree.inventory.values()) {
    for (const edge of node.edgesOut.values()) {
      if (edge.dev || edge.optional) continue
      assert.ok(edge.valid, `${node.name}: unresolved dependency ${edge.name}@${edge.spec}`)
    }
  }
  const manifest = JSON.parse(await readFile(join(installed.path, "package.json"), "utf8"))
  const entries = Host.resolve({ directory: installed.path, name: manifest.name })
  assert.ok(entries.server && entries.tui, "packed server and TUI entrypoints are discoverable")
  const server = await Host.load(entries.server)
  assert.equal(server.default.id, "agents.view")
  console.log(`Package install passed: ${manifest.name}@${manifest.version}, OpenCode's resolver, entrypoints and server loading`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
