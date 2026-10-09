import { describe, expect, it } from "vitest"
import { canDetach, shouldOpenOnStartup } from "../src/navigation.ts"
import { parseOptions } from "../src/options.ts"

describe("Claude-style entry behavior", () => {
  const route = { type: "session", sessionID: "running" } as const
  const editor = { plainText: "", isDestroyed: false }
  it("opens on an unmodified empty prompt while the session may be running", () => {
    expect(canDetach(route, "base", editor)).toBe(true)
  })
  it("passes Left through for nonempty drafts, dialogs, forms and missing focus", () => {
    expect(canDetach(route, "base", { ...editor, plainText: "draft" })).toBe(false)
    expect(canDetach(route, "base", { ...editor, plainText: " \t\r\n " })).toBe(true)
    expect(canDetach(route, "modal", editor)).toBe(false)
    expect(canDetach(route, "form", editor)).toBe(false)
    expect(canDetach(route, "base", null)).toBe(false)
    expect(canDetach(route, "base", { ...editor, extmarks: { getAll: () => ["attachment"] } })).toBe(false)
  })
  it("honors default entry only from home and without explicit startup intent", () => {
    expect(shouldOpenOnStartup({ type: "home" }, true, [])).toBe(true)
    expect(shouldOpenOnStartup({ type: "home" }, false, [])).toBe(false)
    expect(shouldOpenOnStartup(route, true, [])).toBe(false)
    for (const flag of ["--prompt", "--prompt=fix it", "--continue", "-c", "--session", "-s", "--session=123", "--fork"]) {
      expect(shouldOpenOnStartup({ type: "home" }, true, [flag])).toBe(false)
    }
    expect(shouldOpenOnStartup({ type: "home" }, true, ["--standalone", "/repo"])).toBe(true)
  })
  it("validates plugin-local configuration", () => {
    expect(parseOptions({}).leftArrowOpensAgents).toBe(true)
    expect(parseOptions({ defaultToAgentsView: true }).defaultToAgentsView).toBe(true)
    expect(() => parseOptions({ defaultToAgentsView: "true" })).toThrow("boolean")
    expect(() => parseOptions({ refreshIntervalMs: 100 })).toThrow("1000")
    expect(() => parseOptions({ scope: "directory" })).toThrow("scope")
  })
})
