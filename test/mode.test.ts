import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { readPermissionMode } from "../src/mode.ts"

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "agents-mode-")) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

async function config(root: string, text: string) {
  await mkdir(join(root, "opencode"), { recursive: true })
  await writeFile(join(root, "opencode", "cli.json"), text)
}

it("defaults to prompting when no CLI setting exists", async () => {
  expect(await readPermissionMode({}, home)).toBe("prompt")
})

it("reads live changes from the global CLI settings", async () => {
  await config(join(home, ".config"), '{"session":{"permissions":"autoaccept"}}')
  expect(await readPermissionMode({}, home)).toBe("autoaccept")
  await config(join(home, ".config"), '{"session":{"permissions":"prompt"}}')
  expect(await readPermissionMode({}, home)).toBe("prompt")
})

it("honors XDG and inline overrides without losing unrelated session settings", async () => {
  const env = { XDG_CONFIG_HOME: join(home, "custom"), OPENCODE_CLI_CONFIG_CONTENT: '{"session":{"sidebar":"hide"}}' }
  await config(env.XDG_CONFIG_HOME, '{"session":{"permissions":"autoaccept"}}')
  expect(await readPermissionMode(env, home)).toBe("autoaccept")
  env.OPENCODE_CLI_CONFIG_CONTENT = '{"session":{"permissions":"prompt"}}'
  expect(await readPermissionMode(env, home)).toBe("prompt")
})

it("shows unknown rather than off for unreadable or unsupported settings", async () => {
  await config(join(home, ".config"), '{broken')
  expect(await readPermissionMode({}, home)).toBe("unknown")
  await config(join(home, ".config"), '{"session":{"permissions":"other"}}')
  expect(await readPermissionMode({}, home)).toBe("unknown")
  expect(await readPermissionMode({ OPENCODE_CLI_CONFIG_CONTENT: '{broken' }, home)).toBe("unknown")
})
