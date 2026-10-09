import type { Context } from "@opencode/plugin/tui/context"
import { describe, expect, it, vi } from "vitest"
import { createSessionHistory } from "../src/history.ts"

function setup() {
  let sessionID = "a"
  const editor = {
    plainText: "draft", cursorOffset: 0, isDestroyed: false, scrollY: 0,
    visualCursor: { visualRow: 0 }, editorView: { getTotalVirtualLineCount: () => 1 },
    extmarks: { getAll: () => [] as unknown[] },
    setText(text: string) { this.plainText = text }, moveCursorUp: vi.fn(), moveCursorDown: vi.fn(),
  }
  const list = vi.fn(async ({ sessionID, cursor }: { sessionID: string; cursor?: string }) => ({
    data: [{ type: "user", text: `${sessionID}-${cursor ? "old" : "new"}` }],
    cursor: { next: cursor ? null : "older" },
  }))
  const context = {
    renderer: { currentFocusedEditor: editor }, client: { message: { list } },
    keymap: { mode: { current: () => "base" } },
    ui: { router: { current: () => ({ type: "session", sessionID }) }, toast: { show: vi.fn() } },
  } as unknown as Context
  return { editor, list, history: createSessionHistory(context, () => true), switchSession: (id: string) => { sessionID = id } }
}

describe("session-local prompt history", () => {
  it("retries empty history so later messages become available", async () => {
    const f = setup()
    f.list.mockResolvedValueOnce({ data: [], cursor: { next: null } })
    await f.history.move(-1)
    expect(f.editor.plainText).toBe("draft")
    await f.history.move(-1)
    expect(f.editor.plainText).toBe("a-new")
  })
  it("cancels a stale load without blocking another chat's history", async () => {
    const f = setup()
    let finish!: (value: Awaited<ReturnType<typeof f.list>>) => void
    f.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const old = f.history.move(-1)
    f.switchSession("b")
    f.history.reset()
    await f.history.move(-1)
    expect(f.editor.plainText).toBe("b-new")
    finish({ data: [{ type: "user", text: "stale" }], cursor: { next: null } })
    await old
    expect(f.editor.plainText).toBe("b-new")
  })
  it("pages through this chat's prompts and restores the draft", async () => {
    const f = setup()
    await f.history.move(-1)
    expect(f.editor.plainText).toBe("a-new")
    await f.history.move(-1)
    expect(f.editor.plainText).toBe("a-old")
    f.editor.cursorOffset = f.editor.plainText.length
    await f.history.move(1)
    expect(f.editor.plainText).toBe("a-new")
    await f.history.move(1)
    expect(f.editor.plainText).toBe("draft")
    expect(f.list.mock.calls.map(([input]) => input.sessionID)).toEqual(["a", "a"])
    expect(f.list.mock.calls[0][0]).toEqual({ sessionID: "a", type: "user", order: "desc", limit: 100 })
    expect(f.list.mock.calls[1][0]).toEqual({ sessionID: "a", cursor: "older" })
  })
  it("never reuses another session's traversal", async () => {
    const f = setup()
    await f.history.move(-1)
    f.switchSession("b")
    f.editor.plainText = ""
    await f.history.move(-1)
    expect(f.editor.plainText).toBe("b-new")
  })
  it("leaves edited drafts and attached drafts untouched", async () => {
    const f = setup()
    const request = f.history.move(-1)
    f.editor.plainText = "edited during loading"
    await request
    expect(f.editor.plainText).toBe("edited during loading")
    f.list.mockClear()
    f.editor.extmarks.getAll = () => ["attachment"]
    await f.history.move(-1)
    expect(f.list).not.toHaveBeenCalled()
  })
  it("does not apply a pending response after switching chats", async () => {
    const f = setup()
    const request = f.history.move(-1)
    f.switchSession("b")
    await request
    expect(f.editor.plainText).toBe("draft")
  })
})
