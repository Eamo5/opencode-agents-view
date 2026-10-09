export interface Options {
  defaultToAgentsView: boolean
  leftArrowOpensAgents: boolean
  scope: "all" | "project"
  refreshIntervalMs: number
}

export function parseOptions(input: Readonly<Record<string, unknown>>): Options {
  function boolean(key: string, fallback: boolean) {
    const value = input[key]
    if (value === undefined) return fallback
    if (typeof value !== "boolean") throw new Error(`agents.view: ${key} must be a boolean`)
    return value
  }
  const scope = input.scope ?? "all"
  if (scope !== "all" && scope !== "project") throw new Error('agents.view: scope must be "all" or "project"')
  const refreshIntervalMs = input.refreshIntervalMs ?? 5000
  if (typeof refreshIntervalMs !== "number" || !Number.isInteger(refreshIntervalMs) || refreshIntervalMs < 1000) {
    throw new Error("agents.view: refreshIntervalMs must be an integer of at least 1000")
  }
  return {
    defaultToAgentsView: boolean("defaultToAgentsView", false),
    leftArrowOpensAgents: boolean("leftArrowOpensAgents", true),
    scope,
    refreshIntervalMs,
  }
}
