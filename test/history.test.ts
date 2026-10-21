import type { Context } from "@opencode/plugin/tui/context"
import { describe, expect, it, vi } from "vitest"
import { createSessionHistory } from "../src/history.ts"

function setup(peek = false) {
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
  const recalled = vi.fn()
  if (peek) {
    context.ui.router.current = () => ({ type: "plugin", id: "agents.view", name: "agents" })
    context.keymap.mode.current = () => "agents-view"
  }
  return { editor, list, recalled, history: createSessionHistory(context, () => true,
    peek ? { sessionID: () => sessionID, onRecall: recalled } : undefined), switchSession: (id: string) => { sessionID = id } }
}

describe("session-local prompt history", () => {
  it.each([true, false])("restores an empty draft after the editor normalizes a recalled prompt (peek=%s)", async (peek) => {
    const f = setup(peek)
    f.editor.plainText = ""
    f.editor.setText = function (text: string) { this.plainText = text.replaceAll("\r\n", "\n") }
    f.list.mockResolvedValueOnce({ data: [{ type: "user", text: "previous\r\nprompt" }], cursor: { next: null } })
    await f.history.move(-1)
    expect(f.editor.plainText).toBe("previous\nprompt")
    if (peek) expect(f.recalled).toHaveBeenLastCalledWith("previous\nprompt")
    f.editor.cursorOffset = f.editor.plainText.length
    await f.history.move(1)
    expect(f.editor.plainText).toBe("")
    expect(f.editor.cursorOffset).toBe(0)
    if (peek) expect(f.recalled).toHaveBeenLastCalledWith("")
  })
  it("recalls peek prompts from any cursor position and restores the multiline draft", async () => {
    const f = setup(true)
    f.editor.plainText = "my\nunfinished reply"
    f.editor.cursorOffset = 3
    await f.history.move(-1)
    expect(f.editor.plainText).toBe("a-new")
    expect(f.editor.cursorOffset).toBe("a-new".length)
    await f.history.move(-1)
    expect(f.editor.plainText).toBe("a-old")
    await f.history.move(1)
    expect(f.editor.plainText).toBe("a-new")
    await f.history.move(1)
    expect(f.editor.plainText).toBe("my\nunfinished reply")
    expect(f.recalled).toHaveBeenLastCalledWith("my\nunfinished reply")
    expect(f.editor.moveCursorUp).not.toHaveBeenCalled()
  })
  it("keeps edits to recalled prompts as the new draft", async () => {
    const f = setup(true)
    await f.history.move(-1)
    f.editor.plainText = "edited prompt"
    await f.history.move(-1)
    expect(f.editor.plainText).toBe("a-new")
    await f.history.move(1)
    expect(f.editor.plainText).toBe("edited prompt")
  })
  it("does not replace a peek draft when the selected session changes during loading", async () => {
    const f = setup(true)
    const pending = f.history.move(-1)
    f.switchSession("b")
    await pending
    expect(f.editor.plainText).toBe("draft")
    expect(f.recalled).not.toHaveBeenCalled()
  })
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
