import { describe, expect, it } from "vitest"
import { applyLayout, moveOrder, wholeFolders, type Group, type Row } from "../src/model.ts"
import { createController } from "../src/controller.ts"
import { parseOptions } from "../src/options.ts"
import { fixture, session } from "./fixture.ts"

describe("manual layout", () => {
  it("moves selected runs together without wrapping or reversing their order", () => {
    expect(moveOrder(["a", "b", "c", "d"], new Set(["b", "c"]), -1)).toEqual(["b", "c", "a", "d"])
    expect(moveOrder(["a", "b", "c", "d"], new Set(["b", "c"]), 1)).toEqual(["a", "d", "b", "c"])
    expect(moveOrder(["a", "b", "c"], new Set(["a", "c"]), -1)).toEqual(["a", "c", "b"])
    expect(moveOrder(["a", "b"], new Set(["a", "b"]), 1)).toEqual(["a", "b"])
  })

  it("keeps Pinned first and appends new folders after saved folders", () => {
    const groups: Group[] = [
      { id: "pinned", title: "Pinned", rows: [] },
      ...["new", "a", "b"].map((id) => ({ id, title: id, directory: id, rows: [] })),
    ]
    expect(applyLayout(groups, { folders: ["b", "missing", "a"] }).map((group) => group.id)).toEqual(["pinned", "b", "a", "new"])
  })

  it("treats a highlight made only of whole folders as those folders, including their pinned chats", () => {
    const row = (id: string, directory: string): Row => ({ session: session(id, { location: { directory } }), state: "completed", summary: "", pinned: false })
    const groups: Group[] = [
      { id: "pinned", title: "Pinned", rows: [row("a1", "/a"), row("c1", "/c")] },
      { id: "directory:posix:/a", title: "/a", directory: "/a", rows: [row("a2", "/a"), row("a3", "/a")] },
      { id: "directory:posix:/b", title: "/b", directory: "/b", rows: [row("b1", "/b"), row("b2", "/b")] },
      { id: "directory:posix:/c", title: "/c", directory: "/c", rows: [] },
    ]
    expect(wholeFolders(groups, new Set(["a1", "a2", "a3"]))).toEqual(["/a"])
    expect(wholeFolders(groups, new Set(["a1", "a2", "a3", "b1", "b2"]))).toEqual(["/a", "/b"])
    expect(wholeFolders(groups, new Set(["a2", "a3"])), "a pinned chat of the folder is not selected").toEqual([])
    expect(wholeFolders(groups, new Set(["a1", "a2", "a3", "b1"])), "a partial folder keeps session moves").toEqual([])
    expect(wholeFolders(groups, new Set(["a1", "c1"])), "pinned chats of pinned-only folders reorder within Pinned").toEqual([])
  })

  it("moves several highlighted folders together", async () => {
    const f = fixture([session("a"), session("b", { location: { directory: "/b" } }), session("c", { location: { directory: "/c" } })])
    const c = createController(f.context, parseOptions({}))
    try {
      await c.refresh()
      const before = c.groups().map((group) => group.directory)
      await c.reorder(c.groups(), 1, before.slice(0, 2) as string[], new Set())
      expect(c.groups().map((group) => group.directory)).toEqual([before[2], before[0], before[1]])
    } finally { c.dispose() }
  })

  it("persists session and folder order through activity changes, refresh and controller recreation", async () => {
    const f = fixture([session("a"), session("b"), session("c", { location: { directory: "/other" } })])
    let c = createController(f.context, parseOptions({}))
    try {
      await c.refresh()
      await c.reorder(c.groups(), 1, null, new Set(["a"]))
      const folders = c.groups().map((group) => group.directory!)
      await c.reorder(c.groups(), 1, folders[0], new Set())
      const expected = c.groups().map((group) => ({ id: group.id, rows: group.rows.map((row) => row.session.id) }))
      expect(expected.find((group) => group.id === "directory:posix:/project")?.rows).toEqual(["b", "a"])
      await c.reply("a", "Newest prompt should not reset manual ordering")
      await c.refresh()
      c.dispose()
      c = createController(f.context, parseOptions({}))
      await c.refresh()
      expect(c.groups().map((group) => ({ id: group.id, rows: group.rows.map((row) => row.session.id) }))).toEqual(expected)
    } finally { c.dispose() }
  })
})
