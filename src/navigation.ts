import type { Route } from "@opencode/plugin/tui/context"

export const PAGE = "agents-view"

export function isAgentsView(route: Route) {
  return route.type === "plugin" && route.id === "agents.view" && route.name === PAGE
}

/** Explicit CLI session/prompt intent takes precedence over the landing setting. */
export function shouldOpenOnStartup(route: Route, enabled: boolean, argv: readonly string[]) {
  if (!enabled || route.type !== "home") return false
  return !argv.some((arg) => /^(--prompt|--session|--continue|--fork|--resume)(=|$)/.test(arg) || /^-[sc](=|$)/.test(arg))
}

export interface EditorSnapshot {
  plainText: string
  isDestroyed: boolean
  extmarks?: { getAll(): readonly unknown[] }
}

export function canDetach(route: Route, mode: string, editor: EditorSnapshot | null | undefined) {
  return (route.type === "home" || route.type === "session") && mode === "base" &&
    !!editor && !editor.isDestroyed && editor.plainText.trim().length === 0 &&
    (editor.extmarks?.getAll().length ?? 0) === 0
}
