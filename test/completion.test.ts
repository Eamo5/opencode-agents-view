import type { SkillInfo } from "@opencode/client"
import { describe, expect, it } from "vitest"
import { commandCatalog, complete, completionToken, completions, skillMentions } from "../src/completion.ts"

const skills: SkillInfo[] = [
  { id: "review", name: "Code Review", description: "Review changes", path: "/skills/review.md", content: "Review" },
  { id: "release", name: "Release", autoinvoke: false, path: "/skills/release.md", content: "Release" },
]

describe("composer completion", () => {
  it("merges server commands, reachable local commands and aliases, with local precedence", () => {
    const catalog = commandCatalog([{ name: "review" }, { name: "settings", description: "Server" }], [
      { id: "settings", title: "Local settings", slash: { name: "settings", aliases: ["config"] }, run() {} },
      { id: "disabled", slash: { name: "disabled" }, enabled: false, run() {} },
      { id: "unavailable", slash: { name: "unavailable" }, enabled: () => false, run() {} },
      { id: "palette-only", run() {} },
    ])
    expect(catalog.find((entry) => entry.name === "settings")).toMatchObject({ kind: "local", commandID: "settings", description: "Local settings" })
    expect(catalog.find((entry) => entry.name === "config")).toMatchObject({ commandID: "settings" })
    expect(catalog.some((entry) => entry.name === "review" && entry.kind === "command")).toBe(true)
    expect(catalog.some((entry) => ["disabled", "unavailable", "palette-only"].includes(entry.name))).toBe(false)
    expect(commandCatalog([], [], false).map((entry) => entry.name)).toEqual(["models", "exit", "quit", "stop"])
  })

  it("completes slash commands only at the start, and skill mentions at word boundaries", () => {
    expect(completionToken(" /rev")).toEqual({ kind: "command", query: "rev", start: 1, end: 5 })
    expect(completionToken("Review @rev")).toMatchObject({ kind: "skill", query: "rev", start: 7 })
    expect(completionToken("/review @")).toMatchObject({ kind: "skill", query: "" })
    for (const text of ["review /rev", "/review args", "email@rev", "https://example", "@review "]) {
      expect(completionToken(text)).toBeUndefined()
    }
    expect(completionToken("@review", 4)).toBeUndefined()
    expect(completionToken("@rev rest", 4)).toMatchObject({ kind: "skill", query: "rev" })
  })

  it("filters case-insensitively, ranks prefixes first, and includes explicitly invoked skills", () => {
    const catalog = commandCatalog([{ name: "preview" }, { name: "review" }, { name: "release" }], [])
    expect(completions("/REV", 4, catalog, skills).map((entry) => entry.name)).toEqual(["review", "preview"])
    expect(completions("@re", 3, catalog, skills).map((entry) => entry.name)).toEqual(["release", "review"])
    expect(completions("/missing", 8, catalog, skills)).toEqual([])
  })

  it("replaces only the active token, preserves suffixes and leaves room for arguments", () => {
    const entry = { name: "review", kind: "skill" as const }
    expect(complete("Please @rev", 11, entry)).toEqual({ text: "Please @review ", cursor: 15 })
    expect(complete("@rev rest", 4, entry)).toEqual({ text: "@review rest", cursor: 8 })
    expect(complete("/rev", 4, { name: "review", kind: "command" })).toEqual({ text: "/review ", cursor: 8 })
    expect(complete("ordinary text", 13, entry)).toBeUndefined()
  })

  it("attaches exact case-sensitive skill IDs with offsets, not emails or unknown mentions", () => {
    expect(skillMentions("Use @review\nthen @release", skills)).toEqual([
      { id: "review", mention: { start: 4, end: 11, text: "@review" } },
      { id: "release", mention: { start: 17, end: 25, text: "@release" } },
    ])
    expect(skillMentions("@Review @unknown email@review @review-extra", skills)).toBeUndefined()
  })
})
