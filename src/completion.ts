import type { CommandInfo, SessionPromptInput, SkillInfo } from "@opencode/client"
import type { KeymapCommand } from "@opencode/plugin/tui/context"

export interface Completion {
  name: string
  description?: string
  kind: "command" | "local" | "skill"
  commandID?: string
}

export const DASHBOARD_COMMANDS: Completion[] = [
  { name: "models", description: "Choose model for the selected chat or new task", kind: "local" },
  { name: "exit", description: "Quit OpenCode", kind: "local" },
  { name: "quit", description: "Quit OpenCode", kind: "local" },
  { name: "resume", description: "Restore hidden agents", kind: "local" },
  ...["agents-view", "av", "bg", "background"].map((name) => ({ name, description: "Open agents view", kind: "local" as const })),
]

export function commandCatalog(commands: readonly CommandInfo[], local: readonly KeymapCommand[], dashboard = true): Completion[] {
  const entries = new Map<string, Completion>()
  for (const command of commands) entries.set(command.name, { ...command, kind: "command" })
  for (const command of local) {
    if (!command.id || !command.slash || command.enabled === false ||
      (typeof command.enabled === "function" && !command.enabled())) continue
    for (const name of [command.slash.name, ...command.slash.aliases ?? []]) {
      entries.set(name, { name, description: command.description ?? command.title, kind: "local", commandID: command.id })
    }
  }
  for (const command of DASHBOARD_COMMANDS) {
    if (dashboard || command.name === "exit" || command.name === "quit" || command.name === "models") entries.set(command.name, command)
  }
  if (!dashboard) entries.set("stop", { name: "stop", description: "Interrupt this session", kind: "local" })
  return [...entries.values()]
}

export function completionToken(text: string, cursor = text.length) {
  const before = text.slice(0, cursor)
  // Only complete a command at the beginning, and skill mentions at word boundaries.
  const slash = /^\s*\/([^\s]*)$/.exec(before)
  const skill = /(?:^|\s)@([^\s@]*)$/.exec(before)
  const match = slash ?? skill
  if (!match || /[^\s]/.test(text[cursor] ?? "")) return undefined
  return { kind: slash ? "command" as const : "skill" as const, query: match[1], start: cursor - match[1].length - 1, end: cursor }
}

export function completions(text: string, cursor: number, commands: readonly Completion[], skills: readonly SkillInfo[]) {
  const token = completionToken(text, cursor)
  if (!token) return []
  const query = token.query.toLowerCase()
  const entries: Completion[] = token.kind === "skill" ? skills.map((skill) => ({
    name: skill.id, description: skill.description ?? skill.name, kind: "skill",
  })) : [...commands]
  return entries.filter((entry) => entry.name.toLowerCase().includes(query))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)) || a.name.localeCompare(b.name))
}

export function complete(text: string, cursor: number, entry: Completion) {
  const token = completionToken(text, cursor)
  if (!token) return undefined
  const inserted = `${entry.kind === "skill" ? "@" : "/"}${entry.name}`
  const suffix = text.slice(token.end)
  const space = suffix.startsWith(" ") ? "" : " "
  return { text: text.slice(0, token.start) + inserted + space + suffix, cursor: token.start + inserted.length + 1 }
}

export function skillMentions(text: string, skills: readonly SkillInfo[]): SessionPromptInput["skills"] {
  const result: NonNullable<SessionPromptInput["skills"]>[number][] = []
  for (const match of text.matchAll(/(^|\s)@([^\s]+)/g)) {
    const skill = skills.find((skill) => skill.id === match[2])
    if (!skill) continue
    const start = match.index! + match[1].length
    result.push({ id: skill.id, mention: { start, end: start + skill.id.length + 1, text: `@${skill.id}` } })
  }
  return result.length ? result : undefined
}
