import type { Context } from "@opencode/plugin/tui/context"
import type { TextareaRenderable } from "@opentui/core"

/** Text-only prompt recall, isolated to the exact active session (not its family). */
export function createSessionHistory(context: Context, normalMode: () => boolean, prompt?: {
  sessionID(): string | undefined
  onRecall(text: string): void
}) {
  const activeSession = () => {
    if (prompt) return prompt.sessionID()
    const route = context.ui.router.current()
    return route.type === "session" && context.keymap.mode.current() === "base" ? route.sessionID : undefined
  }
  let state: { sessionID: string; editor: TextareaRenderable; entries: string[]; index: number; draft: string; shown: string } | undefined
  let pending: AbortController | undefined
  let disposed = false
  const reset = () => { state = undefined; pending?.abort(); pending = undefined }

  async function move(direction: -1 | 1) {
    const sessionID = activeSession()
    const editor = context.renderer.currentFocusedEditor as TextareaRenderable | undefined
    if (disposed || !sessionID || !normalMode() ||
      !editor || editor.isDestroyed) return
    // Match native multiline navigation before entering history at buffer edges.
    if (!prompt && direction === -1 && editor.cursorOffset !== 0) {
      if (editor.scrollY + editor.visualCursor.visualRow === 0) editor.cursorOffset = 0
      else editor.moveCursorUp()
      return
    }
    if (!prompt && direction === 1 && editor.cursorOffset !== editor.plainText.length) {
      if (editor.scrollY + editor.visualCursor.visualRow === Math.max(0, editor.editorView.getTotalVirtualLineCount() - 1)) {
        editor.cursorOffset = editor.plainText.length
      } else editor.moveCursorDown()
      return
    }
    // Public plugin APIs cannot reconstruct native attachment extmarks. Never
    // replace an attached draft or fall through to another chat's history.
    if (editor.extmarks.getAll().length || pending) return
    const text = editor.plainText
    if (!state || state.sessionID !== sessionID || state.editor !== editor || state.shown !== text) reset()
    if (!state) {
      if (direction === 1) return
      const request = new AbortController()
      pending = request
      const offset = editor.cursorOffset
      try {
        const entries: string[] = []
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          // The cursor already encodes the filters, ordering and page size.
          // OpenCode rejects combining it with the initial query options.
          const page = await context.client.message.list(cursor ? { sessionID, cursor } :
            { sessionID, type: "user", order: "desc", limit: 100 }, { signal: request.signal })
          if (request.signal.aborted) return
          for (const message of page.data) {
            if (message.type === "user" && message.text.trim()) entries.push(message.text)
          }
          cursor = page.cursor?.next ?? undefined
          if (cursor && seen.has(cursor)) throw new Error("History pagination returned a repeated cursor")
          if (cursor) seen.add(cursor)
        } while (cursor)
        if (disposed || request.signal.aborted || !entries.length || editor.isDestroyed || context.renderer.currentFocusedEditor !== editor ||
          activeSession() !== sessionID || !normalMode() ||
          editor.plainText !== text || editor.cursorOffset !== offset || editor.extmarks.getAll().length) return
        state = { sessionID, editor, entries, index: -1, draft: text, shown: text }
      } catch (cause) {
        if (!disposed && !request.signal.aborted) context.ui.toast.show({ message: `Could not load this chat's prompt history: ${cause instanceof Error ? cause.message : String(cause)}`, variant: "error" })
        return
      } finally { if (pending === request) pending = undefined }
    }
    const next = Math.max(-1, Math.min(state.entries.length - 1, state.index - direction))
    if (next === state.index) return
    state.index = next
    state.shown = next === -1 ? state.draft : state.entries[next]
    editor.setText(state.shown)
    // The native buffer normalizes text (for example CRLF to LF). Remember
    // what it actually displays so Down doesn't mistake recall for an edit
    // and discard the traversal, including its original empty draft.
    state.shown = editor.plainText
    editor.cursorOffset = prompt ? state.shown.length : direction === -1 ? 0 : state.shown.length
    prompt?.onRecall(state.shown)
    if (next === -1) reset()
  }

  return { move, reset, dispose() { disposed = true; reset() } }
}
