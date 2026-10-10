import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export type PermissionMode = "prompt" | "autoaccept" | "unknown"

/** CLI permissions belong to this terminal, including when its server is remote. */
export async function readPermissionMode(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<PermissionMode> {
  try {
    const path = join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "cli.json")
    let config: { session?: { permissions?: unknown } } = {}
    try {
      config = JSON.parse(await readFile(path, "utf8"))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
    }
    const inline = env.OPENCODE_CLI_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CLI_CONFIG_CONTENT) : {}
    const mode = inline.session?.permissions ?? config.session?.permissions ?? "prompt"
    return mode === "prompt" || mode === "autoaccept" ? mode : "unknown"
  } catch {
    // An unreadable setting must never be presented as auto mode being off.
    return "unknown"
  }
}
