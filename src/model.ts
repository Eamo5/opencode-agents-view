import type { FormInfo, PermissionRequest, SessionInfo, SessionMessageInfo } from "@opencode/client"
import { posix, win32 } from "node:path"

export type AgentState = "needs-input" | "working" | "completed" | "failed" | "stopped" | "idle"
export type Grouping = "state" | "directory"
export interface Row {
  session: SessionInfo
  state: AgentState
  summary: string
  pinned: boolean
}
export interface Group {
  id: string
  title: string
  directory?: string
  rows: Row[]
}

/** Compare server paths by their own syntax, not the terminal's platform. */
export function directoryKey(directory: string): string {
  if (/^(?:[a-z]:[\\/]|\\\\|\/\/[^/])/i.test(directory)) {
    const path = directory.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "")
    const normalized = win32.normalize(path)
    const root = win32.parse(normalized).root
    return `windows:${(normalized.length > root.length ? normalized.replace(/[\\/]+$/, "") : normalized).toLowerCase()}`
  }
  const normalized = posix.normalize(directory)
  return `posix:${normalized === "/" ? normalized : normalized.replace(/\/+$/, "")}`
}

export function uniqueDirectories(directories: readonly string[]): string[] {
  const unique = new Map<string, string>()
  for (const directory of directories) {
    const key = directoryKey(directory)
    if (!unique.has(key)) unique.set(key, directory)
  }
  return [...unique.values()]
}

export const STATE_LABEL: Record<AgentState, string> = {
  "needs-input": "Needs input", working: "Working", completed: "Completed",
  failed: "Failed", stopped: "Stopped", idle: "Idle",
}
const ORDER: Record<AgentState, number> = {
  "needs-input": 0, working: 1, idle: 2, completed: 3, failed: 3, stopped: 3,
}

export function rootSession(id: string, sessions: ReadonlyMap<string, SessionInfo>): string {
  const seen = new Set<string>()
  while (!seen.has(id)) {
    seen.add(id)
    const parent = sessions.get(id)?.parentID
    if (!parent) return id
    id = parent
  }
  return id
}

export function stateOf(session: SessionInfo, running: boolean, blocked: boolean): AgentState {
  if (blocked) return "needs-input"
  if (running) return "working"
  if (session.outcome === "failed") return "failed"
  if (session.outcome === "interrupted") return "stopped"
  if (session.outcome === "succeeded") return "completed"
  return "idle"
}

/** Summaries reuse output already produced by a session; they never make model calls. */
export function messageSummary(messages: readonly SessionMessageInfo[]): string {
  for (const message of [...messages].reverse()) {
    if (message.type === "assistant") {
      if (message.error) return message.error.message
      const tool = [...message.content].reverse().find((part) => part.type === "tool" &&
        (part.state.status === "running" || part.state.status === "streaming"))
      if (tool?.type === "tool") {
        const status = tool.state.status === "running" ? tool.state.metadata.status : undefined
        return typeof status === "string" ? status : `Running ${tool.name}`
      }
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim()
      if (text) return text
    }
    if (message.type === "user" || message.type === "synthetic") {
      if (message.text.trim()) return message.text
    }
    if (message.type === "shell") return message.output?.output.trim() || message.command
  }
  return ""
}

export function requestSummary(permissions: readonly PermissionRequest[], forms: readonly FormInfo[]): string {
  const permission = permissions[0]
  if (permission) return permission.message || `Permission: ${permission.action} ${permission.resources.join(", ")}`
  const form = forms[0]
  if (form) return form.fields.find((field) => !("hidden" in field && field.hidden))?.title || form.title
  return ""
}

export function oneLine(text: string) {
  // Keep terminal control characters out of the table and peek text.
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim()
}

export function matches(row: Row, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+(?=[anso]:)/)
  return terms.every((term) => {
    if (term.startsWith("a:")) return (row.session.agent ?? "build").toLowerCase().includes(term.slice(2))
    if (term.startsWith("s:")) {
      const value = term.slice(2)
      return (value === "blocked" && row.state === "needs-input") ||
        row.state.includes(value) || STATE_LABEL[row.state].toLowerCase().includes(value)
    }
    if (term.startsWith("n:")) return (row.session.title ?? "").toLowerCase().includes(term.slice(2))
    if (term.startsWith("o:")) return !!row.summary && row.summary.toLowerCase().includes(term.slice(2))
    return `${row.session.title ?? ""} ${row.summary} ${row.session.location.directory}`.toLowerCase().includes(term)
  })
}

export function groupRows(rows: readonly Row[], grouping: Grouping, query = "", directories: readonly string[] = []): Group[] {
  const groups = new Map<string, Group>()
  const names = new Map(uniqueDirectories(directories).map((directory) => [directoryKey(directory), directory]))
  const folder = (directory: string): Group => {
    const key = directoryKey(directory)
    const path = names.get(key) ?? directory
    return { id: `directory:${key}`, title: path, directory: path, rows: [] }
  }
  // Keep known inactive folders available for dispatch, but don't add empty
  // groups to filtered search results. The launch folder uses this same map.
  if (grouping === "directory" && !query.trim()) {
    for (const directory of names.values()) {
      const group = folder(directory)
      groups.set(group.id, group)
    }
  }
  const sorted = rows.filter((row) => matches(row, query)).toSorted((a, b) =>
    Number(b.pinned) - Number(a.pinned) ||
    (grouping === "state" ? ORDER[a.state] - ORDER[b.state] : 0) ||
    a.session.time.created - b.session.time.created || a.session.id.localeCompare(b.session.id))
  for (const row of sorted) {
    if (grouping === "directory") {
      // Pins sort within their folder instead of duplicating its layout.
      const candidate = folder(row.session.location.directory)
      const group = groups.get(candidate.id) ?? candidate
      group.rows.push(row)
      groups.set(group.id, group)
      continue
    }
    const id = row.pinned ? "pinned" :
      ["needs-input", "idle"].includes(row.state) ? "needs-input" :
      ["completed", "failed", "stopped"].includes(row.state) ? "completed" : row.state
    const title = id === "pinned" ? "Pinned" : id === "needs-input" ? "Needs action" : STATE_LABEL[id as AgentState]
    const group = groups.get(id) ?? { id, title, rows: [] }
    group.rows.push(row)
    groups.set(id, group)
  }
  if (grouping === "directory") {
    return [...groups.values()].toSorted((a, b) => directoryKey(a.directory!).localeCompare(directoryKey(b.directory!)))
  }
  const order = ["pinned", "needs-input", "working", "completed"]
  return [...groups.values()].toSorted((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
}

export function elapsed(session: SessionInfo, state: AgentState, now: number) {
  const end = ["completed", "failed", "stopped"].includes(state) ? (session.time.idle ?? session.time.updated) : now
  const seconds = Math.max(0, Math.floor((end - session.time.created) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}
