import type { KeymapCommand } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import type { MouseEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Controller } from "./controller.ts"
import { commandCatalog, complete, completionToken, completions } from "./completion.ts"
import { readPermissionMode, type PermissionMode } from "./mode.ts"
import { createSessionHistory } from "./history.ts"
import { STATE_LABEL, directoryKey, groupRows, messageSummary, oneLine, wholeFolders, type AgentState, type Group, type Row } from "./model.ts"

const ICON: Record<AgentState, string> = {
  "needs-input": "!", working: "▶", "background-shell": "▶", completed: "●", failed: "×", stopped: "●", idle: "!",
}
// OpenCode's default session-tab spinner (spinner-frames.ts), at 80ms/frame.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const folderID = (directory: string) => `new-session-${directoryKey(directory)}`

function folderActivity(rows: readonly Row[]) {
  const count = (states: AgentState[]) => rows.filter((row) => states.includes(row.state)).length
  const counts = [
    [count(["needs-input", "idle"]), "needs input"],
    [count(["working"]), "working"],
    [count(["background-shell"]), "background shell"],
    [count(["failed"]), "failed"],
  ] as const
  return counts.filter(([value]) => value).map(([value, label]) => `${value} ${label}`).join(" · ") ||
    `${rows.length} session${rows.length === 1 ? "" : "s"}`
}

function sessionAge(created: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - created) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

export function AgentsView(props: { controller: Controller }) {
  const c = props.controller
  const context = c.context
  const dimensions = useTerminalDimensions()
  const [input, setInput] = createSignal<TextareaRenderable>()
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()
  const [previewLoading, setPreviewLoading] = createSignal(false)
  const [previewHeight, setPreviewHeight] = createSignal(1)
  const [showShortcuts, setShowShortcuts] = createSignal(false)
  const [folderCursor, setFolderCursor] = createSignal<string | null>(
    c.memory.previous.type === "home" && !c.memory.selected && c.grouping() === "directory" ?
      c.location().directory : null,
  )
  const [selectionVisible, setSelectionVisible] = createSignal(true)
  const [highlighted, setHighlighted] = createSignal<ReadonlySet<string>>(new Set())
  const [spinnerFrame, setSpinnerFrame] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const [permissionMode, setPermissionMode] = createSignal<PermissionMode>("unknown")
  const [completionCursor, setCompletionCursor] = createSignal(0)
  const [completionIndex, setCompletionIndex] = createSignal(0)
  const [dismissedCompletion, setDismissedCompletion] = createSignal("")
  let mounted = false
  let previewSequence = 0
  let mouseSelection = false
  let mouseDrag: { anchor: string; x: number; y: number; enabled: boolean; base: ReadonlySet<string> } | undefined
  // OpenTUI can send release to both the captured row and the drop target.
  // Keep suppressing clicks until the next press, not just the first release.
  let dragged = false
  const peek = () => c.memory.peek && !!c.selectedSession()
  const promptSession = () => !composing() && !folderCursor() && !highlighted().size ? c.selectedSession() : undefined
  const pickerLocation = () => ({ directory: c.memory.selectedDirectory ?? folderCursor() ?? c.dispatchLocation().directory })
  const promptLocation = () => promptSession()?.location ?? pickerLocation()
  // OpenCode lists the resolved default first, including plugin overrides and
  // fallbacks. Resolve it for display only; null still dispatches server-side.
  const promptAgentID = () => promptSession()?.agent ?? c.memory.agent ??
    context.data.location.agent.list(promptLocation())?.find((agent) => !agent.hidden && agent.mode !== "subagent")?.id
  const promptAgent = () => context.data.location.agent.list(promptLocation())?.find((agent) => agent.id === promptAgentID())
  const promptAgentName = () => promptAgent()?.name ?? promptAgentID() ?? "Agent unavailable"
  // Defaulted sessions may only expose their resolved model on the latest
  // assistant message.
  const sessionModel = (session: SessionInfo) => session.model ??
    c.messages(session.id).findLast((message) => message.type === "assistant")?.model ??
    context.data.location.agent.list(session.location)?.find((agent) => agent.id === session.agent)?.model
  const sharedModel = (sessions: readonly SessionInfo[]) => {
    const models = sessions.map(sessionModel)
    const first = models[0]
    return first && models.every((model) => model?.providerID === first.providerID && model.id === first.id) ? first : undefined
  }
  const highlightedSessions = () => c.rows().filter((row) => highlighted().has(row.session.id)).map((row) => row.session)
  // Highlighted chats take precedence over the cursor's chat or the next task.
  const modelTargets = () => highlighted().size ? highlightedSessions() : promptSession() ? [promptSession()!] : []
  const promptModel = () => {
    // Show the model of the chat under the cursor, even while others are
    // highlighted, so scrolling identifies each chat's model. Otherwise show
    // the independently retained model for the next task.
    const session = !composing() && !folderCursor() ? c.selectedSession() : undefined
    if (session) return sessionModel(session)
    return c.memory.model ?? promptAgent()?.model
  }
  // Match OpenCode's native agent palette: visible-agent order, with duplicate
  // categorical colors removed. The accent hue is unrelated to agent colors.
  const agentColors = createMemo(() => context.theme.categorical.map((scale) => scale[200])
    .filter((color, index, colors) => colors.findIndex((other) => other.equals(color)) === index))
  const promptAgentColor = () => {
    const agents = context.data.location.agent.list(promptLocation())?.filter((agent) => !agent.hidden) ?? []
    const index = agents.findIndex((agent) => agent.id === promptAgentID())
    const color = agents[index]?.color
    if (color) return color
    const colors = agentColors()
    return colors[Math.max(0, index) % colors.length] ?? context.theme.text.base
  }
  createEffect(on(() => promptLocation().directory, () => {
    void context.data.location.agent.sync(promptLocation()).catch(c.report)
  }))
  const draft = () => peek() ? c.memory.replies[c.memory.selected!] ?? "" : c.memory.draft
  const completionLocation = () => peek() ? c.selectedSession()?.location ?? pickerLocation() : pickerLocation()
  const catalog = () => commandCatalog(context.data.location.command.list(completionLocation()) ?? [], context.keymap.commands(), !peek())
  const completionKey = (text = draft(), cursor = completionCursor()) =>
    JSON.stringify([completionLocation().directory, peek() ? c.memory.selected : null, text, cursor])
  const suggestions = createMemo(() => dismissedCompletion() === completionKey() || (!peek() && /^[anso]:/i.test(draft())) ? [] :
    completions(draft(), completionCursor(), catalog(), context.data.location.skill.list(completionLocation()) ?? []))
  const completionLimit = () => Math.max(1, Math.min(6, Math.floor(dimensions().height / 4)))
  const visibleSuggestions = () => suggestions().slice(Math.max(0, completionIndex() - completionLimit() + 1),
    Math.max(0, completionIndex() - completionLimit() + 1) + completionLimit())
  createEffect(on(completionKey, () => setCompletionIndex(0)))
  createEffect(() => {
    const length = suggestions().length
    setCompletionIndex((index) => length ? Math.min(index, length - 1) : 0)
  })
  createEffect(on(() => completionLocation().directory, () => {
    const location = completionLocation()
    void context.data.location.command.sync(location).catch(c.report)
    void context.data.location.skill.sync(location).catch(c.report)
  }))
  const liveSuggestions = () => {
    const area = input()
    const text = area?.plainText ?? draft()
    const cursor = area?.cursorOffset ?? completionCursor()
    return dismissedCompletion() === completionKey(text, cursor) || (!peek() && /^[anso]:/i.test(text)) ? [] :
      completions(text, cursor, catalog(), context.data.location.skill.list(completionLocation()) ?? [])
  }
  const acceptCompletion = (index = completionIndex()) => {
    const area = input()
    const entry = liveSuggestions()[index] ?? liveSuggestions()[0]
    if (!area || !entry) return false
    const result = complete(area.plainText, area.cursorOffset, entry)
    if (!result) return false
    area.setText(result.text)
    area.cursorOffset = result.cursor
    updateDraft(result.text)
    setCompletionCursor(result.cursor)
    area.focus()
    return true
  }
  const filtering = () => !peek() && /^[anso]:/i.test(c.memory.draft)
  const isTask = (value: string) => !peek() && !highlighted().size && !!value.trim() && !/^[anso]:/i.test(value)
  const composing = () => isTask(draft())
  const liveTask = () => isTask(input()?.plainText ?? draft())
  const liveFilter = () => !peek() && /^[anso]:/i.test(input()?.plainText ?? draft())
  const query = () => filtering() ? c.memory.draft : ""
  const allRows = createMemo(() => c.rows())
  const ageWidth = createMemo(() => Math.max(3, ...allRows().map((row) => sessionAge(row.session.time.created, now()).length)))
  const directories = createMemo(() => c.directories())
  const taskDirectory = () => composing() ? c.dispatchLocation().directory : !peek() && !filtering() ? folderCursor() : null
  const groups = createMemo(() => c.arrange(groupRows(allRows(), c.grouping(), query(), directories(),
    c.available(c.location().directory) ? c.location().directory : undefined,
    taskDirectory() && c.available(taskDirectory()!) ? taskDirectory()! : undefined)))
  // Retain rendered group/row identities as summaries stream in. A fresh array
  // of plain objects otherwise makes <For> destroy and remount the entire list.
  const [renderGroups, setRenderGroups] = createStore<Group[]>([])
  createEffect(() => setRenderGroups(reconcile(groups().map((group) => ({
    ...group, rows: group.rows.map((row) => ({ ...row, id: row.session.id })),
  })))))
  const isCollapsed = (directory: string) => !filtering() && c.isCollapsed(directory)
  const rows = createMemo(() => groups().flatMap((group) => group.directory && isCollapsed(group.directory) ? [] : group.rows))
  const hasWorkingRows = createMemo(() => rows().some((row) => row.state === "working" || row.state === "background-shell"))
  createEffect(() => {
    if (!hasWorkingRows()) return
    const timer = setInterval(() => setSpinnerFrame((frame) => (frame + 1) % SPINNER_FRAMES.length), 80)
    onCleanup(() => clearInterval(timer))
  })
  const targets = createMemo(() => groups().flatMap((group) => [
    ...(group.directory && !filtering() && !peek() ? [{ directory: group.directory, sessionID: "" }] : []),
    ...(group.directory && isCollapsed(group.directory) ? [] : group.rows.map((row) => ({ directory: "", sessionID: row.session.id }))),
  ]))
  const targetOrder = createMemo(() => targets().map((target) => target.sessionID || folderID(target.directory)).join("|"))
  const selected = createMemo(() => folderCursor() ? undefined : rows().find((row) => row.session.id === c.memory.selected))
  const confirmingHide = (id: string) => c.stopConfirmation()?.ids.includes(id)
  const clearHighlights = () => {
    setHighlighted(new Set<string>())
    c.clearStopConfirmation()
  }
  const highlight = (ids: string[], toggle = false) => {
    c.clearStopConfirmation()
    setHighlighted((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (toggle && next.has(id)) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }
  const folderHighlights = createMemo(() => {
    const result = new Map<string, { total: number; selected: number; confirming: boolean }>()
    for (const row of groups().flatMap((group) => group.rows)) {
      const key = directoryKey(row.session.location.directory)
      const count = result.get(key) ?? { total: 0, selected: 0, confirming: false }
      count.total++
      if (highlighted().has(row.session.id)) {
        count.selected++
        count.confirming ||= !!confirmingHide(row.session.id)
      }
      result.set(key, count)
    }
    return result
  })
  const folderHighlight = (directory: string) => folderHighlights().get(directoryKey(directory))
  const folderTitle = (directory: string, rows: readonly Row[]) => {
    const count = folderHighlight(directory)
    return (highlighted().size ? folderSelected(directory) ? "› " : "  " : "") +
      `${isCollapsed(directory) ? "▸" : "▾"} ${context.ui.format.path(directory)}` +
      (isCollapsed(directory) ? ` · ${folderActivity(rows)}` : "") +
      (count?.selected ? ` · ${count.selected === count.total ? "✓ " : ""}${count.selected}/${count.total} selected${count.confirming ? " · ctrl+x again to hide" : ""}` : "")
  }
  const toggleFolderHighlights = (directory: string) => {
    // Include pinned sessions too: their display group is not their folder.
    const ids = groups().flatMap((group) => group.rows)
      .filter((row) => directoryKey(row.session.location.directory) === directoryKey(directory))
      .map((row) => row.session.id)
    if (!ids.length) return
    c.clearStopConfirmation()
    setHighlighted((current) => {
      const next = new Set(current)
      const remove = ids.every((id) => current.has(id))
      for (const id of ids) {
        if (remove) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }
  // Search and collapsed folders only change visibility, not batch recipients.
  // Prune selections only when sessions leave the underlying inventory.
  createEffect(() => {
    const available = new Set(allRows().map((row) => row.session.id))
    const current = highlighted()
    if (peek()) {
      if (current.size) clearHighlights()
      return
    }
    const retained = [...current].filter((id) => available.has(id))
    if (retained.length !== current.size) {
      setHighlighted(new Set(retained))
      c.clearStopConfirmation()
    }
  })
  const selectedID = () => composing() ? folderID(c.dispatchLocation().directory) :
    folderCursor() ? folderID(folderCursor()!) : c.memory.selected ? `agent-${c.memory.selected}` : undefined
  const rowFocused = (id: string) => selectionVisible() && !composing() && !folderCursor() && id === c.memory.selected
  const folderSelected = (directory: string) => composing() ?
    directoryKey(c.dispatchLocation().directory) === directoryKey(directory) : selectionVisible() && folderCursor() === directory
  const previewRows = () => /(^|\s)o:/i.test(query()) ? allRows() : rows().slice(0, dimensions().height)
  const previewBatch = createMemo(() => previewRows().map((row) => `${row.session.id}:${row.session.time.updated}`).join("|"))
  const color = (state: AgentState) => state === "needs-input" || state === "idle" ? context.theme.text.feedback.warning.base :
    state === "working" || state === "background-shell" ? "#f59e0b" : state === "completed" ? context.theme.text.feedback.success.base :
      state === "failed" ? context.theme.text.feedback.error.base : context.theme.text.muted
  const updateDraft = (value: string) => c.updateMemory((memory) => {
    if (peek()) memory.replies[memory.selected!] = value
    else {
      // Capture the navigation target before entering composition mode.
      if (isTask(value) && !memory.selectedDirectory) {
        memory.selectedDirectory = folderCursor() ?? c.dispatchLocation().directory
      }
      memory.draft = value
    }
  })
  const promptHistory = createSessionHistory(context, peek, {
    sessionID: () => peek() ? c.memory.selected ?? undefined : undefined,
    onRecall: (text) => {
      // Recalled commands/skill mentions are history, not newly typed queries.
      // Keep autocomplete from taking over Up/Down until the user edits them.
      setDismissedCompletion(completionKey(text, text.length))
      updateDraft(text)
    },
  })
  onCleanup(promptHistory.dispose)
  createEffect(on([() => c.memory.selected, peek], promptHistory.reset))
  const run = (action: () => void | Promise<unknown>) => {
    try {
      const result = action()
      if (result instanceof Promise) void result.catch(c.report)
    } catch (cause) { c.report(cause) }
  }
  const select = (id: string | null) => {
    // Content callbacks are batched; save a live reply before changing its owner.
    if (peek()) updateDraft(input()?.plainText ?? draft())
    mouseSelection = false
    setSelectionVisible(true)
    setFolderCursor(null)
    c.select(id)
  }
  const hoverSession = (id: string) => {
    if (liveTask() || peek()) return
    setSelectionVisible(true)
    mouseSelection = true
    setFolderCursor(null)
    c.select(id)
  }
  const hoverFolder = (directory: string) => {
    if (peek() || filtering()) return
    setSelectionVisible(true)
    mouseSelection = true
    if (liveTask()) selectFolder(directory)
    else setFolderCursor(directory)
  }
  const startMouseSelection = (event: MouseEvent) => {
    if (event.button !== 0) return
    mouseDrag = undefined
    dragged = false
    let target = event.target
    while (target && !target.id.startsWith("agent-")) target = target.parent
    const anchor = rows().find((row) => `agent-${row.session.id}` === target?.id)?.session.id
    if (!anchor) return
    // Pressing a row must not move keyboard focus to its scrollbox, including
    // when task/peek editing temporarily disables multi-selection.
    event.preventDefault()
    mouseDrag = { anchor, x: event.x, y: event.y,
      enabled: !peek() && !liveTask() && !liveSuggestions().length,
      base: event.modifiers.shift || event.modifiers.ctrl ? highlighted() : new Set<string>() }
  }
  const dragMouseSelection = (event: MouseEvent) => {
    const gesture = mouseDrag
    const box = scroll()
    if (event.button !== 0 || !gesture || !box || box.isDestroyed) return
    if (!dragged && event.x === gesture.x && event.y === gesture.y) return
    dragged = true
    event.preventDefault()
    if (!gesture.enabled) return
    const list = rows()
    const anchor = list.findIndex((row) => row.session.id === gesture.anchor)
    if (anchor < 0) { mouseDrag = undefined; return }
    // Drag events stay captured by one renderable. Use screen coordinates,
    // rather than that event target, to find the row now under the pointer.
    let destination = -1
    let nearest = Infinity
    for (const [index, row] of list.entries()) {
      const item = box.content.findDescendantById(`agent-${row.session.id}`)
      if (!item || item.y + item.height <= box.viewport.y || item.y >= box.viewport.y + box.viewport.height) continue
      const distance = Math.max(item.y - event.y, event.y - (item.y + item.height - 1), 0)
      if (distance < nearest) { nearest = distance; destination = index }
    }
    if (destination < 0) return
    const next = new Set(gesture.base)
    for (const row of list.slice(Math.min(anchor, destination), Math.max(anchor, destination) + 1)) next.add(row.session.id)
    c.clearStopConfirmation()
    setHighlighted(next)
    hoverSession(list[destination].session.id)
  }
  const endMouseSelection = (event: MouseEvent) => {
    if (event.button !== 0) return
    if (mouseDrag && dragged) dragMouseSelection(event)
    mouseDrag = undefined
    if (dragged) input()?.focus()
  }
  const toggleFolder = (directory: string) => {
    if (filtering()) return
    // Toggling keeps the folder as the active keyboard and mouse target.
    setSelectionVisible(true)
    c.updateMemory((memory) => { memory.peek = false })
    setFolderCursor(directory)
    run(() => c.toggleDirectory(directory))
  }
  const quit = () => context.keymap.dispatch("app.exit")
  const selectFolder = (directory: string) => {
    if (!liveTask()) return
    updateDraft(input()?.plainText ?? draft())
    // Keep the session cursor so clearing the task returns to that conversation.
    c.updateMemory((memory) => { memory.selectedDirectory = directory })
  }
  const move = (offset: number, extend = false) => {
    setSelectionVisible(true)
    mouseSelection = false
    if (liveFilter()) updateDraft(input()?.plainText ?? draft())
    if (liveTask()) {
      updateDraft(input()?.plainText ?? draft())
      // Folder navigation must match the rendered headings, not the inventory
      // of historical directories (which also includes hidden/archived rows).
      const list = c.grouping() === "directory" ?
        groups().flatMap((group) => group.directory ? [group.directory] : []) : directories()
      if (!list.length) return
      const index = list.findIndex((directory) => directoryKey(directory) === directoryKey(c.dispatchLocation().directory))
      selectFolder(list[index < 0 ? (offset < 0 ? list.length - 1 : 0) :
        (index + offset % list.length + list.length) % list.length])
      return
    }
    const list = targets()
    if (!list.length) return
    const index = list.findIndex((target) => folderCursor() ? target.directory === folderCursor() : target.sessionID === c.memory.selected)
    const target = list[index < 0 ? (offset < 0 ? list.length - 1 : 0) :
      (index + offset % list.length + list.length) % list.length]
    if (extend) highlight([list[index]?.sessionID, target.sessionID].filter((id): id is string => !!id))
    if (target.directory) setFolderCursor(target.directory)
    else select(target.sessionID)
  }
  const attach = () => {
    const row = selected()
    if (row) c.attach(row.session.id)
  }
  const submit = async (attachImmediately = false) => {
    const area = input()
    const token = completionToken(area?.plainText ?? draft(), area?.cursorOffset ?? completionCursor())
    const suggestion = liveSuggestions()[completionIndex()] ?? liveSuggestions()[0]
    if (!attachImmediately && suggestion && token?.query !== suggestion.name && acceptCompletion()) return
    const value = input()?.plainText ?? draft()
    // Commit the live buffer before admission; content callbacks may still be
    // queued. The controller only clears this revision after a successful send.
    updateDraft(value)
    const local = /^\s*\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(value.trim())
    if (local) {
      if (local[1] === "models") {
        const session = !folderCursor() && !highlighted().size ? c.selectedSession() : undefined
        updateDraft("")
        await chooseModel(highlighted().size ? highlightedSessions() : session ? [session] : [])
        return
      }
      const entry = catalog().find((entry) => entry.name === local[1] && entry.kind === "local")
      if (entry?.commandID) {
        updateDraft("")
        context.keymap.dispatch(entry.commandID, local[2] ?? "")
        return
      }
      if (["exit", "quit"].includes(local[1])) { quit(); return }
    }
    if (peek()) {
      const id = c.memory.selected
      if (!value.trim()) await attach()
      else if (id) await c.reply(id, value)
      return
    }
    if (/^[anso]:/i.test(value)) {
      updateDraft(value)
      const matches = groups().flatMap((group) => group.rows)
      const row = matches.find((row) => row.session.id === c.memory.selected) ?? matches[0]
      if (row) c.attach(row.session.id)
      return
    }
    if (highlighted().size) {
      const recipients = highlighted()
      const result = await c.replyMany([...recipients], value)
      // Don't replace a selection the user changed while admission was pending.
      if (result?.failed.length && highlighted() === recipients) setHighlighted(new Set(result.failed))
      return
    }
    if (!value.trim()) {
      if (folderCursor()) toggleFolder(folderCursor()!)
      else await attach()
      return
    }
    if (["/agents-view", "/av", "/bg", "/background"].includes(value.trim())) { updateDraft(""); return }
    if (["/exit", "/quit"].includes(value.trim())) { quit(); return }
    if (value.trim() === "/resume") {
      await c.restoreHidden()
      updateDraft("")
      return
    }
    await c.dispatch(value, attachImmediately)
  }
  const escape = () => {
    if (highlighted().size) { clearHighlights(); return }
    if (liveSuggestions().length) {
      const area = input()
      setDismissedCompletion(completionKey(area?.plainText ?? draft(), area?.cursorOffset ?? completionCursor()))
      return
    }
    c.clearStopConfirmation()
    if ((input()?.plainText ?? draft()).length) { input()?.setText(""); updateDraft(""); return }
    if (peek()) { c.updateMemory((memory) => { memory.peek = false }); return }
    c.back()
  }
  const chooseAgent = async () => {
    const response = await context.client.agent.list({ location: pickerLocation() })
    const defaultAgent = response.data.find((agent) => !agent.hidden && agent.mode !== "subagent")
    const agent = await context.ui.dialog.select({
      title: "Dispatch agent", current: c.memory.agent ?? "",
      options: [{ title: `${defaultAgent?.name ?? "Agent unavailable"} (default)`, value: "", description: "Use the configured OpenCode default" },
        ...response.data.filter((agent) => !agent.hidden).map((agent) => ({
          title: agent.name, value: agent.id, description: agent.description,
        }))],
    })
    if (agent !== undefined) c.setDispatchAgent(agent || null)
  }
  const chooseModel = async (targets: readonly SessionInfo[] = modelTargets()) => {
    // Capture the targets before opening the asynchronous picker.
    const sessions = [...targets]
    const current = sessions.length ? sharedModel(sessions) : c.memory.model
    const response = await context.client.model.list({ location: sessions[0]?.location ?? pickerLocation() })
    const models = response.data
    const value = await context.ui.dialog.select({
      title: sessions.length > 1 ? `Model for ${sessions.length} chats` : sessions.length ? "Chat model" : "Dispatch model",
      current: current ? `${current.providerID}/${current.id}` : "",
      options: [...(sessions.length ? [] : [{ title: "Default model", value: "", description: "Use the agent's configured model" }]),
        ...models.map((model) => ({ title: model.name, value: `${model.providerID}/${model.id}`, category: model.providerID }))],
    })
    if (value === undefined) return
    const model = models.find((model) => `${model.providerID}/${model.id}` === value)
    if (sessions.length) {
      if (model) await c.setSessionModel(sessions.map((session) => session.id), { providerID: model.providerID, id: model.id })
      return
    }
    c.updateMemory((memory) => {
      memory.model = model ? { providerID: model.providerID, id: model.id } : null
      memory.modelInitialized = true
      memory.modelSelected = true
    })
  }
  const chooseFolder = async () => {
    if (peek() || highlighted().size || liveFilter()) return
    updateDraft(input()?.plainText ?? draft())
    const current = directoryKey(pickerLocation().directory)
    const directories = c.directories()
    const directory = await context.ui.dialog.select({
      title: "New session in folder", current: directories.find((path) => directoryKey(path) === current),
      options: directories.map((path) => ({
        title: context.ui.format.path(path), value: path,
        description: directoryKey(path) === directoryKey(c.location().directory) ? "Launch folder" : "Previously used folder",
      })),
    })
    if (directory !== undefined) {
      if (liveTask()) selectFolder(directory)
      else {
        setSelectionVisible(true)
        mouseSelection = false
        setFolderCursor(directory)
      }
    }
    input()?.focus()
  }

  context.keymap.layer(() => {
    // OpenTUI batches content-change callbacks until rendering. Inspect the
    // buffer itself so fast typing/pasting cannot turn a space into Peek.
    const empty = () => (input()?.plainText ?? draft()).length === 0
    const canHighlight = () => !peek() && !liveTask() && !liveSuggestions().length
    const actionIDs = () => highlighted().size ? [...highlighted()] : selected() ? [selected()!.session.id] : []
    const rowCommand = (bind: string, title: string, action: (row: Row) => void | Promise<unknown>): KeymapCommand => ({
      bind, title, enabled: () => !!selected(), run: () => { const row = selected(); if (row) run(() => action(row)) },
    })
    return {
      mode: "agents-view", priority: 20, target: () => input(),
      commands: [
        { bind: "return", title: "Dispatch / attach / reply", run: () => run(() => submit()) },
        { bind: "ctrl+return", title: "Dispatch and attach", run: () => run(() => submit(true)) },
        { bind: "escape", title: "Deselect / close peek / clear / return", run: escape },
        ...([-1, 1] as const).map((offset) => ({
          bind: offset < 0 ? "shift+up" : "shift+down", title: "Highlight sessions / recall prompt in peek",
          enabled: () => peek() || canHighlight(),
          run: () => { if (peek()) run(() => promptHistory.move(offset)); else move(offset, true) },
        })),
        ...([-1, 1] as const).map((offset) => ({
          bind: offset < 0 ? "ctrl+shift+up" : "ctrl+shift+down", title: "Reorder folders / sessions",
          enabled: () => !peek() && empty(),
          run: () => {
            mouseSelection = false
            setSelectionVisible(true)
            const list = groups()
            // Highlighting whole folders moves those folders, from a chat row or their heading.
            const whole = highlighted().size ? wholeFolders(list, highlighted()) : []
            const cursor = folderCursor()
            const folders = cursor && !whole.some((directory) => directoryKey(directory) === directoryKey(cursor)) ? [cursor] : whole
            run(() => c.reorder(list, offset, folders, highlighted().size ? highlighted() : new Set(selected() ? [selected()!.session.id] : [])))
          },
        })),
        { bind: "shift+right", title: "Toggle session / entire folder selection", enabled: () => canHighlight() && (!!folderCursor() || !!selected()),
          run: () => {
            if (folderCursor()) toggleFolderHighlights(folderCursor()!)
            else if (selected()) highlight([selected()!.session.id], true)
          } },
        { bind: "shift+left", title: "Deselect all sessions", run: clearHighlights },
        ...([-1, 1] as const).map((offset) => ({
          bind: offset < 0 ? "up" : "down", title: "Select completion / recall prompt / session / task folder",
          enabled: () => !!liveSuggestions().length || peek() || !!highlighted().size || empty() || liveTask() || liveFilter(),
          run: () => {
            const list = liveSuggestions()
            if (list.length) setCompletionIndex((index) => (index + offset + list.length) % list.length)
            else if (peek() && !empty()) run(() => promptHistory.move(offset))
            else move(offset)
          },
        })),
        { bind: "pageup", title: "Previous page", enabled: empty, run: () => move(-Math.max(1, dimensions().height - 12)) },
        { bind: "pagedown", title: "Next page", enabled: empty, run: () => move(Math.max(1, dimensions().height - 12)) },
        { bind: "home", title: "First session", enabled: empty, run: () => { const row = rows()[0]; if (row) select(row.session.id) } },
        { bind: "end", title: "Last session", enabled: empty, run: () => { const row = rows().at(-1); if (row) select(row.session.id) } },
        { bind: "right", title: "Attach", enabled: () => empty() || filtering(), run: () => run(attach) },
        { bind: "space", title: "Collapse / expand folder / peek / reply", enabled: empty, run: () => {
          if (folderCursor()) toggleFolder(folderCursor()!)
          else if (selected()) c.updateMemory((memory) => { memory.peek = !memory.peek })
        } },
        { bind: "ctrl+s", title: "Group by state / directory", run: () => run(c.toggleGrouping) },
        { bind: "alt+s", title: "Group by state / directory", run: () => run(c.toggleGrouping) },
        { bind: "ctrl+n", title: "Choose task folder", enabled: () => !peek() && !highlighted().size && !liveFilter(), run: () => run(chooseFolder) },
        { bind: "ctrl+t", title: "Pin / unpin selected sessions", enabled: () => !!actionIDs().length, run: () => run(async () => {
          const ids = actionIDs()
          const pin = c.rows().some((row) => ids.includes(row.session.id) && !row.pinned)
          await c.togglePin(ids)
          context.ui.toast.show({ message: `${ids.length === 1 ? "Session" : `${ids.length} sessions`} ${pin ? "pinned" : "unpinned"}` })
        }) },
        { bind: "ctrl+x", title: "Stop / hide selected sessions", enabled: () => !!actionIDs().length,
          run: () => run(() => c.stopOrHide(actionIDs())) },
        { bind: "ctrl+z", title: "Undo hide session", enabled: () => empty() && !peek() && !!c.lastHidden(), run: () => run(c.undoHide) },
        rowCommand("ctrl+r", "Rename session", async (row) => {
          const value = await context.ui.dialog.prompt({ title: "Rename session", value: row.session.title })
          if (value?.trim()) await c.rename(row.session.id, value.trim())
        }),
        { bind: "ctrl+f", title: "Find session", run: () => {
          c.updateMemory((memory) => { memory.peek = false; memory.draft = "n:" })
          input()?.focus()
        } },
        { bind: "tab", title: "Complete / choose dispatch agent", run: () => { if (!acceptCompletion()) run(chooseAgent) } },
        { bind: "ctrl+g", title: "Choose chat / dispatch model", run: () => run(chooseModel) },
        { bind: "alt+m", title: "Choose chat / dispatch model", run: () => run(chooseModel) },
        { bind: "ctrl+l", title: "Refresh sessions", run: () => run(c.refresh) },
        { bind: "ctrl+c", title: "Deselect sessions / quit OpenCode", run: () => {
          if (highlighted().size) clearHighlights()
          else quit()
        } },
        { bind: "?", title: "Toggle keyboard shortcuts", enabled: () => showShortcuts() || empty(), run: () => {
          // Returning false lets the keymap pass the key through to the textarea.
          setShowShortcuts((value) => !value)
        } },
      ],
    }
  })

  createEffect(() => c.syncInitialModel())
  let compositionCursor: { sessionID: string | null } | undefined
  createEffect(() => {
    if (composing()) {
      compositionCursor ??= { sessionID: c.memory.selected }
      if (folderCursor() && !c.memory.selectedDirectory) {
        const directory = folderCursor()!
        c.updateMemory((memory) => { memory.selectedDirectory = directory })
      }
    } else {
      // Keep the original folder cursor while editing, including when the last
      // character is erased. A successful dispatch selects the new session.
      if (compositionCursor && compositionCursor.sessionID !== c.memory.selected) setFolderCursor(null)
      compositionCursor = undefined
      if (c.memory.selectedDirectory) c.updateMemory((memory) => { memory.selectedDirectory = null })
    }
  })
  let previousSessionIDs: string[] = []
  createEffect(() => {
    const list = rows()
    const previous = previousSessionIDs
    previousSessionIDs = list.map((row) => row.session.id)
    if (composing()) return
    if (folderCursor()) {
      if (!filtering() && c.available(folderCursor()!)) return
      setFolderCursor(null)
    }
    // The detached conversation may arrive on a later inventory page. Preserve
    // that selection through initial loading or a failed inventory request.
    if (!filtering() && c.memory.selected && (c.loading() || c.refreshFailed())) return
    const containing = groups().find((group) => group.directory && isCollapsed(group.directory) &&
      group.rows.some((row) => row.session.id === c.memory.selected))
    if (containing?.directory) {
      setFolderCursor(containing.directory)
      return
    }
    if (!list.some((row) => row.session.id === c.memory.selected)) {
      // Keep the cursor near a removed row instead of jumping to the top.
      // Use visible order so this also respects filters, pins and grouping.
      const index = previous.indexOf(c.memory.selected ?? "")
      const visible = new Set(previousSessionIDs)
      const neighbor = index < 0 ? undefined :
        previous.slice(index + 1).find((id) => visible.has(id)) ??
        previous.slice(0, index).reverse().find((id) => visible.has(id))
      if (list.length) select(neighbor ?? list[0].session.id)
      else if (c.memory.selected) select(null)
    }
  })
  createEffect(() => {
    const id = selectedID()
    const box = scroll()
    dimensions()
    targetOrder()
    if (!id || !box || mouseSelection) return
    const reveal = () => {
      if (!box.isDestroyed && !mouseSelection && selectedID() === id) box.scrollChildIntoView(id)
    }
    queueMicrotask(reveal)
    // Reordered rows receive their new coordinates during the next layout pass.
    const afterLayout = () => queueMicrotask(reveal)
    context.renderer.once("frame", afterLayout)
    onCleanup(() => { context.renderer.off("frame", afterLayout) })
  })
  createEffect(() => {
    const area = input()
    const value = draft()
    if (!area || area.isDestroyed || area.plainText === value) return
    area.setText(value)
    area.cursorOffset = value.length
  })
  createEffect(on([() => selected()?.session.id, () => selected()?.session.time.updated, peek], () => {
    const row = selected()
    const sequence = ++previewSequence
    if (!row) return
    setPreviewLoading(true)
    void c.loadPreview(row.session, peek()).finally(() => {
      if (mounted && sequence === previewSequence) setPreviewLoading(false)
    })
  }))
  createEffect(on([previewBatch, c.refreshGeneration], () => { void c.loadPreviews(previewRows().map((row) => row.session)) }))
  onMount(() => {
    mounted = true
    const refreshMode = async () => {
      const mode = await readPermissionMode()
      if (mounted) setPermissionMode(mode)
    }
    void refreshMode()
    const modeTimer = setInterval(() => void refreshMode(), 2000)
    onCleanup(() => clearInterval(modeTimer))
    const ageTimer = setInterval(() => setNow(Date.now()), 60_000)
    onCleanup(() => clearInterval(ageTimer))
    const pop = context.keymap.mode.push("agents-view")
    input()?.focus()
    void c.refresh()
    onCleanup(() => { mounted = false; pop() })
  })

  const counts = createMemo(() => {
    const list = allRows()
    return `${list.filter((row) => row.state === "needs-input" || row.state === "idle").length} awaiting input · ` +
      `${list.filter((row) => row.state === "working").length} working · ` +
      (list.some((row) => row.state === "background-shell") ? `${list.filter((row) => row.state === "background-shell").length} background shell · ` : "") +
      `${list.filter((row) => row.state === "completed").length} done`
  })
  return (
    <box id="agents-view" width="100%" height="100%" paddingLeft={1} paddingRight={1} paddingTop={dimensions().height > 15 ? 1 : 0}
      paddingBottom={showShortcuts() ? 0 : dimensions().height > 15 ? 2 : 1}
      gap={dimensions().height > 15 ? 1 : 0} backgroundColor={context.theme.background.base}
      onMouseDown={startMouseSelection} onMouseDrag={dragMouseSelection} onMouseUp={endMouseSelection}>
      <box flexShrink={0} flexDirection="row" gap={2}>
        <Show when={dimensions().width >= 30 && dimensions().height > 15}>
          {/* Four-row O matches the header information height, with a shaded lower inset. */}
          <box width={8} flexShrink={0}>
            <text selectable={false} fg={context.theme.text.base}>████████</text>
            <text selectable={false} fg={context.theme.text.base}>{"██    ██"}</text>
            <text selectable={false} fg={context.theme.text.base}>██<span style={{ fg: context.theme.text.muted }}>████</span>██</text>
            <text selectable={false} fg={context.theme.text.base}>████████</text>
          </box>
        </Show>
        <box flexGrow={1} minWidth={0}>
        <text fg={context.theme.text.base} wrapMode="none" truncate>OpenCode v{context.app.version} · Agents · <span
          style={{ fg: permissionMode() === "autoaccept" ? context.theme.text.feedback.warning.base : context.theme.text.muted }}>
          Auto: {permissionMode() === "autoaccept" ? "on" : permissionMode() === "prompt" ? "off" : "unknown"}
        </span></text>
        <Show when={dimensions().height > 15}>
          <text id="agents-view-model" fg={context.theme.text.muted} wrapMode="none" truncate>
            {promptModel()?.id ?? "Default model"} · {context.ui.format.path(c.location().directory)}
          </text>
        </Show>
        <text fg={context.theme.text.muted} wrapMode="none" truncate>{counts()}</text>
        <text fg={context.theme.text.muted} wrapMode="none" truncate>Group: {c.grouping() === "directory" ? "Folders" : "Status"} · Ctrl+S{highlighted().size ? ` · ${highlighted().size} selected · Ctrl+C deselect` : ""}</text>
        </box>
      </box>
      <Show when={dimensions().height > 15}>
        <text fg={context.theme.text.muted} wrapMode="none" truncate>
          {highlighted().size ? "Highlighted sessions · type a prompt, then enter to send to all · shift+← / esc / ctrl+c deselects" : c.memory.previous.type === "session" ? "Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c quits" : "Select a conversation — enter opens it · type a task, then ↑↓ to choose its folder · ctrl+c quits"}
        </text>
      </Show>
      <Show when={taskDirectory() && c.grouping() === "state"}>
        <text fg={context.theme.text.muted} wrapMode="none" truncate>Task folder: {context.ui.format.path(taskDirectory()!)}</text>
      </Show>
      <Show when={c.refreshFailed()}>
        <text fg={context.theme.text.feedback.error.base} wrapMode="none" truncate>Refresh failed: {oneLine(c.error())} · Ctrl+L retries</text>
      </Show>
      <scrollbox ref={setScroll} flexGrow={1} minHeight={1} scrollX={false} contentOptions={{ gap: 1 }}>
        <Show when={groups().length && !c.loading()} fallback={<text fg={context.theme.text.muted}>
          {c.loading() ? "Loading sessions…" : filtering() ? "No matching sessions." : "Describe a task below to start your first agent."}
        </text>}>
          <For each={renderGroups}>{(group) => (
            <box>
              <text id={group.directory ? folderID(group.directory) : undefined} selectable={false}
                attributes={group.directory && (folderSelected(group.directory) || folderHighlight(group.directory)?.selected) ? TextAttributes.BOLD : 0}
                fg={group.directory && (folderSelected(group.directory) || folderHighlight(group.directory)?.selected) ? context.theme.text.base : context.theme.text.muted}
                bg={group.directory && folderHighlight(group.directory)?.selected ? context.theme.background.raised.base : undefined} wrapMode="none" truncate
                onMouseMove={() => { if (group.directory) hoverFolder(group.directory) }}
                onMouseUp={(event) => { if (event.button === 0 && !dragged && group.directory) {
                  if (liveTask()) selectFolder(group.directory)
                  else toggleFolder(group.directory)
                  input()?.focus()
                } }}>
                {group.directory ? folderTitle(group.directory, group.rows) : group.title}
              </text>
              <For each={group.directory && isCollapsed(group.directory) ? [] : group.rows}>{(row) => (
                <box id={`agent-${row.session.id}`} flexDirection="row" gap={1} paddingLeft={1}
                  backgroundColor={highlighted().has(row.session.id) ? context.theme.background.raised.base : undefined}
                  onMouseMove={() => hoverSession(row.session.id)}
                  onMouseUp={(event) => { if (event.button === 0 && !dragged && !liveTask()) { select(row.session.id); c.attach(row.session.id) } }}>
                  <Show when={highlighted().size}>
                    <text selectable={false} fg={context.theme.text.base} width={1}>{rowFocused(row.session.id) ? "›" : " "}</text>
                  </Show>
                  <text selectable={false} fg={color(row.state)} width={1}>{highlighted().has(row.session.id) ? "✓" : row.state === "working" || row.state === "background-shell" ? SPINNER_FRAMES[spinnerFrame()] : ICON[row.state]}</text>
                  <text selectable={false} fg={highlighted().has(row.session.id) || rowFocused(row.session.id) ? context.theme.text.base : context.theme.text.muted}
                    attributes={highlighted().has(row.session.id) || rowFocused(row.session.id) ? TextAttributes.BOLD : 0}
                    width={Math.max(12, Math.min(32, Math.floor(dimensions().width * 0.3)))} flexShrink={0} wrapMode="none" truncate>
                    {oneLine(row.session.title || "current session")}
                  </text>
                  <Show when={dimensions().width > 50}>
                    <text selectable={false} fg={row.state === "working" ? context.theme.text.muted : color(row.state)} flexShrink={0}>{" "}{row.state === "idle" ? "Needs input" : STATE_LABEL[row.state]}</text>
                    <text selectable={false} flexGrow={1} flexShrink={1} minWidth={0}
                      fg={confirmingHide(row.session.id) ? context.theme.text.feedback.error.base : context.theme.text.muted} wrapMode="none">
                      · {confirmingHide(row.session.id) ? "ctrl+x again to hide" : oneLine(row.summary || (row.state === "idle" ? "send a prompt to start" : STATE_LABEL[row.state])).replace(/^[▶▷▸]\s*/u, "")}
                    </text>
                  </Show>
                  <box width={ageWidth() + 3} paddingLeft={2} paddingRight={1} flexShrink={0}>
                    <text selectable={false} fg={context.theme.text.muted} wrapMode="none">
                      {sessionAge(row.session.time.created, now()).padStart(ageWidth())}
                    </text>
                  </box>
                </box>
              )}</For>
            </box>
          )}</For>
        </Show>
      </scrollbox>
      <Show when={peek() && selected()}>{(row) => (
        <box border borderColor={context.theme.border.base} paddingLeft={1} paddingRight={1}
          maxHeight={Math.max(4, Math.floor(dimensions().height / 3))} flexShrink={0}>
          <text fg={color(row().state)} wrapMode="none" truncate flexShrink={0}>
            {STATE_LABEL[row().state]} · {oneLine(row().session.title ?? "New session")}
          </text>
          <scrollbox height={Math.min(previewHeight(), Math.max(1, Math.floor(dimensions().height / 3) - 3))}
            flexShrink={0} scrollX={false} contentOptions={{ minHeight: 0 }}>
            <box onSizeChange={function () { setPreviewHeight(Math.max(1, this.height)) }}>
              <text fg={context.theme.text.base}>
                {oneLine(messageSummary(c.messages(row().session.id)) || row().summary || (previewLoading() ? "Loading recent output…" : "No output yet."))}
              </text>
              <Show when={row().state === "needs-input"}>
                <text fg={context.theme.text.feedback.warning.base}>
                  {oneLine(row().summary)} · Press → to answer the permission or form in the session.
                </text>
              </Show>
            </box>
          </scrollbox>
        </box>
      )}</Show>
      <Show when={suggestions().length}>
        <box id="agents-view-completions" flexShrink={0} paddingLeft={1} paddingRight={1}>
          <For each={visibleSuggestions()}>{(entry) => (
            <text selectable={false} wrapMode="none" truncate
              fg={suggestions()[completionIndex()] === entry ? context.theme.text.base : context.theme.text.muted}
              attributes={suggestions()[completionIndex()] === entry ? TextAttributes.BOLD : 0}
              onMouseMove={() => setCompletionIndex(suggestions().indexOf(entry))}
              onMouseUp={(event) => { if (event.button === 0) acceptCompletion(suggestions().indexOf(entry)) }}>
              {suggestions()[completionIndex()] === entry ? "› " : "  "}{entry.kind === "skill" ? "@" : "/"}{entry.name} · {oneLine(entry.description ?? entry.kind)}
            </text>
          )}</For>
        </box>
      </Show>
      <box id="agents-view-prompt" flexShrink={0}
        paddingLeft={1} paddingRight={1}
        onMouseUp={() => input()?.focus()}>
        <textarea id="agents-view-input" ref={setInput} initialValue={draft()} width="100%" minHeight={1}
          maxHeight={Math.max(1, Math.floor(dimensions().height / 3))} wrapMode="word"
          focusedTextColor={context.theme.text.base} textColor={context.theme.text.base}
          backgroundColor="transparent" focusedBackgroundColor="transparent" cursorColor={context.theme.text.base}
          placeholder={peek() ? "Reply, or Enter / → to attach" : highlighted().size ? `Reply to ${highlighted().size} selected chats` : folderCursor() ? `› Type a task in ${context.ui.format.path(folderCursor()!)}` : "› Type a task to start an agent"}
          placeholderColor={context.theme.text.muted}
          keyBindings={[{ name: "return", shift: true, action: "newline" }, { name: "j", ctrl: true, action: "newline" }]}
          onContentChange={() => { const area = input(); if (area && !area.isDestroyed) { updateDraft(area.plainText); setCompletionCursor(area.cursorOffset) } }}
          onCursorChange={() => { const area = input(); if (area && !area.isDestroyed) setCompletionCursor(area.cursorOffset) }}
          onSubmit={() => run(() => submit())} />
      </box>
      {/* Reserve its row above, but anchor status independently of the peek/composer layout. */}
      <Show when={showShortcuts()} fallback={
        <text id="agents-view-status" position="absolute" bottom={0} left={1} right={1} height={1}
          fg={context.theme.text.muted} wrapMode="none" flexShrink={0}>
          <span style={{ fg: promptAgentColor() }}>{promptAgentName()}</span>{" · "}
          {"ctrl+x stop / hide · ? for shortcuts · "}
          {c.lastHidden() && !draft().length && !peek() ? "ctrl+z undo hide · " : ""}
          {suggestions().length ? "↑↓ select · tab/enter complete · esc dismiss" : peek() ? `${draft().length ? "↑↓" : "shift+↑↓"} recall prompts · enter to ${draft().trim() ? "reply" : "attach"} · → attach · esc close peek` : composing() ? "enter to create · ↑↓ cycle folders · ctrl+n folders · esc clear · ctrl+c quit" : highlighted().size ? `${highlighted().size} selected · enter sends to all · ctrl+shift+↑↓ reorder · shift+← deselect` : "↑↓ select · shift+↑↓ highlight · shift+→ toggle · space peek · ctrl+c quit"}
        </text>
      }>
        <box flexShrink={0} flexDirection="row" flexWrap="wrap" border={["top"]} borderColor={context.theme.border.base}>
          <For each={[
            [peek() ? draft().trim() ? "enter to reply" : "enter to attach" : highlighted().size ? "enter to reply to all" : "enter to create / open", "ctrl+r to rename"],
            ["ctrl+s to switch views", "ctrl+j for newline"],
            [peek() ? "↑↓ recall (typed reply)" : folderCursor() ? "enter / space to fold / unfold" : "space to peek / reply", "ctrl+t to pin / unpin"],
            ["→ to attach", "ctrl+x to stop / hide"],
            ["tab to choose agent", "ctrl+g to choose model"],
            ["/ commands · @ skills", "tab/enter to complete"],
            ["ctrl+n all recent folders", "(before or during a task)"],
            ["↑↓ select / task folder", "pgup/pgdn page (empty)"],
            ["home/end first/last", "(with an empty prompt)"],
            ["drag to highlight rows", "shift/ctrl+drag to add"],
            [peek() ? "shift+↑↓ recall prompts" : "shift+↑↓ extend highlight", "shift+→ toggle selection"],
            ["ctrl+shift+↑↓ reorder", "(folders or sessions)"],
            ["shift+→ on a folder", "select / deselect its chats"],
            ["shift+← deselect all", "(always, without leaving)"],
            ["ctrl+f find session", "ctrl+l refresh sessions"],
            ["ctrl+z undo last hide", "(empty task prompt)"],
            [highlighted().size ? "ctrl+enter send to all" : "ctrl+enter send + attach", "esc close / clear / back"],
            ["ctrl+c deselect / quit", "? to close"],
          ]}>{(column) => (
            <box width={Math.min(25, Math.max(1, dimensions().width - 2))} flexShrink={0}>
              <For each={column}>{(hint) => <text fg={context.theme.text.muted}>{hint}</text>}</For>
            </box>
          )}</For>
        </box>
      </Show>
    </box>
  )
}
