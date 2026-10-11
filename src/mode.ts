import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"

export type PermissionMode = "prompt" | "autoaccept" | "unknown"

/** CLI permissions belong to this terminal, including when its server is remote. */
export async function readPermissionMode(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  args: readonly string[] = process.argv.slice(2),
): Promise<PermissionMode> {
  try {
    // OpenCode's launch flags override session.permissions without updating cli.json.
    // Parse value-taking flags too so a prompt containing "--auto" isn't a mode flag.
    const { values } = parseArgs({
      args: [...args], strict: false, allowPositionals: true,
      options: {
        auto: { type: "boolean" },
        yolo: { type: "boolean" },
        "dangerously-skip-permissions": { type: "boolean" },
        prompt: { type: "string" },
        session: { type: "string", short: "s" },
        server: { type: "string" },
        "log-level": { type: "string" },
        completions: { type: "string" },
      },
    })
    if ([values.auto, values.yolo, values["dangerously-skip-permissions"]]
      .some((value) => value === true || value === "true")) return "autoaccept"

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
