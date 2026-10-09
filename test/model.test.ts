import type { SessionMessageAssistant } from "@opencode/client"
import { describe, expect, it } from "vitest"
import { directoryKey, elapsed, groupRows, matches, messageSummary, rootSession, stateOf, uniqueDirectories, type Row } from "../src/model.ts"
import { session } from "./fixture.ts"

function row(id: string, state: Row["state"], pinned = false): Row {
  return { session: session(id), state, pinned, summary: "Fix login tests" }
}

describe("session state and grouping", () => {
  it("arranges sessions into pinned, needs action, working and completed groups", () => {
    const rows = [row("question", "needs-input"), row("idle", "idle"), row("error", "failed"),
      row("running", "working", true), row("done", "completed"), row("stopped", "stopped")]
    rows.push(row("active", "working"))
    const groups = groupRows(rows, "state")
    expect(groups.map((group) => group.title)).toEqual(["Pinned", "Needs action", "Working", "Completed"])
    expect(groups[1].rows.map((row) => row.session.id)).toEqual(["question", "idle"])
    expect(groups.flatMap((group) => group.rows)).toHaveLength(7)
  })
  it("keeps folder rows stationary across message updates, state changes and reversed inventory", () => {
    const older = { ...row("older", "completed"), session: session("older", { time: { created: 1, updated: 10 } }) }
    const newer = { ...row("newer", "working"), session: session("newer", { time: { created: 2, updated: 20 } }) }
    const ids = (rows: Row[]) => groupRows(rows, "directory")[0].rows.map((item) => item.session.id)
    expect(ids([newer, older])).toEqual(["older", "newer"])
    older.session.time.updated = 500
    older.state = "working"
    newer.state = "needs-input"
    expect(ids([older, newer])).toEqual(["older", "newer"])
    const latest = { ...row("latest", "working"), session: session("latest", { time: { created: 3, updated: 600 } }) }
    expect(ids([latest, newer, older])).toEqual(["older", "newer", "latest"])
  })
  it("keeps folders alphabetical regardless of launch folder, inventory order or filtering", () => {
    const rows = ["/zebra", "/alpha", "/launch"].map((directory) => ({
      ...row(directory, "working"), session: session(directory, { location: { directory } }),
    }))
    const folders = (values: Row[], directories: string[], query = "") =>
      groupRows(values, "directory", query, directories).map((group) => group.directory)
    expect(folders(rows, ["/launch", "/zebra", "/alpha"])).toEqual(["/alpha", "/launch", "/zebra"])
    expect(folders([...rows].reverse(), ["/launch", "/alpha", "/zebra"], "a:build"))
      .toEqual(["/alpha", "/launch", "/zebra"])
    expect(folders(rows, ["/zebra", "/alpha", "/launch"])).toEqual(["/alpha", "/launch", "/zebra"])
  })
  it("does not reorder rows within a state bucket on new messages", () => {
    const older = { ...row("older", "working"), session: session("older", { time: { created: 1, updated: 10 } }) }
    const newer = { ...row("newer", "working"), session: session("newer", { time: { created: 2, updated: 500 } }) }
    expect(groupRows([newer, older], "state")[0].rows.map((item) => item.session.id)).toEqual(["older", "newer"])
  })
  it("gives pending human input precedence over execution and old outcomes", () => {
    expect(stateOf(session("old", { outcome: "succeeded" }), true, true)).toBe("needs-input")
    expect(stateOf(session("old", { outcome: "failed" }), true, false)).toBe("working")
    expect(stateOf(session("old", { outcome: "failed" }), false, false)).toBe("failed")
    expect(stateOf(session("old", { outcome: "interrupted" }), false, false)).toBe("stopped")
    expect(stateOf(session("old"), false, false)).toBe("idle")
  })
  it("pins first and groups failed/stopped rows with finished work", () => {
    const groups = groupRows([row("done", "completed"), row("busy", "working"), row("blocked", "needs-input"),
      row("pin", "idle", true), row("failed", "failed")], "state")
    expect(groups.map((group) => group.id)).toEqual(["pinned", "needs-input", "working", "completed"])
    expect(groups.at(-1)?.rows.map((row) => row.state)).toContain("failed")
  })
  it("combines agent, name, state and output filters", () => {
    expect(matches(row("login", "needs-input"), "s:blocked a:build n:login o:tests")).toBe(true)
    expect(matches(row("login", "working"), "s:blocked")).toBe(false)
  })
  it("merges Windows path variants without collapsing case-sensitive server paths", () => {
    expect(directoryKey("C:\\Users\\Eamon\\Project\\")).toBe(directoryKey("c:/users/eamon/project/."))
    expect(directoryKey("\\\\SERVER\\Share\\project\\")).toBe(directoryKey("//server/share/project"))
    expect(directoryKey("\\\\?\\C:\\Project")).toBe(directoryKey("C:/Project"))
    expect(directoryKey("C:\\")).toBe(directoryKey("c:/"))
    expect(directoryKey("/repo/project/")).toBe(directoryKey("/repo/project"))
    expect(directoryKey("/repo/Project")).not.toBe(directoryKey("/repo/project"))
    expect(uniqueDirectories(["C:/Project", "c:\\project\\", "/repo/Project", "/repo/project"]))
      .toEqual(["C:/Project", "/repo/Project", "/repo/project"])
  })
  it("uses one folder layout for the launch directory and existing sessions, including pins", () => {
    const first = { ...row("working", "working"), session: session("working", { location: { directory: "c:\\work\\project\\" } }) }
    const pinned = { ...row("pinned", "completed", true), session: session("pinned", { location: { directory: "C:/Work/Project" } }) }
    const groups = groupRows([first, pinned], "directory", "", ["C:/Work/Project", "c:\\work\\project"])
    expect(groups).toHaveLength(1)
    expect(groups[0].directory).toBe("C:/Work/Project")
    expect(groups[0].rows.map((row) => row.session.id)).toEqual(["pinned", "working"])
  })
  it("keeps an empty inactive folder in the layout but not in filtered results", () => {
    const groups = groupRows([row("root", "working")], "directory", "", ["/project", "/inactive"])
    expect(groups.map((group) => group.directory)).toEqual(["/inactive", "/project"])
    expect(groups[0].rows).toEqual([])
    expect(groupRows([row("root", "working")], "directory", "n:missing", ["/project", "/inactive"])).toEqual([])
  })
  it("resolves nested subagents to one root row without looping on corrupt hierarchies", () => {
    const entries = [session("root"), session("child", { parentID: "root" }), session("grandchild", { parentID: "child" })]
    expect(rootSession("grandchild", new Map(entries.map((session) => [session.id, session])))).toBe("root")
    expect(rootSession("a", new Map([["a", session("a", { parentID: "b" })], ["b", session("b", { parentID: "a" })]]))).toBe("a")
  })
  it("freezes elapsed time for completed work", () => {
    expect(elapsed(session("done", { time: { created: 1000, updated: 61000, idle: 61000 } }), "completed", 999999)).toBe("1m")
  })
  it("reuses actual assistant output and running tool status", () => {
    const message: SessionMessageAssistant = { id: "m", type: "assistant", agent: "build", model: { providerID: "acme", id: "model" }, time: { created: 1 }, content: [{ type: "text", text: "All tests passed" }] }
    expect(messageSummary([message])).toBe("All tests passed")
    const tool: SessionMessageAssistant = { ...message, content: [{ type: "tool", id: "call", name: "bash", time: { created: 1 }, state: { status: "running", input: {}, metadata: { status: "Running tests" } } }] }
    expect(messageSummary([tool])).toBe("Running tests")
  })
})
