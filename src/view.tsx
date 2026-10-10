import type { KeymapCommand } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Controller } from "./controller.ts"
import { readPermissionMode, type PermissionMode } from "./mode.ts"
import { STATE_LABEL, directoryKey, groupRows, messageSummary, oneLine, type AgentState, type Group, type Row } from "./model.ts"

const ICON: Record<AgentState, string> = {
  "needs-input": "!", working: "▶", "background-shell": "▶", completed: "●", failed: "×", stopped: "●", idle: "!",
}
// OpenCode's default session-tab spinner (spinner-frames.ts), at 80ms/frame.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const folderID = (directory: string) => `new-session-${directoryKey(directory)}`

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
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set())
  const [folderCursor, setFolderCursor] = createSignal<string | null>(
    c.memory.previous.type === "home" && !c.memory.selected && c.grouping() === "directory" ?
      c.location().directory : null,
  )
  const [selectionVisible, setSelectionVisible] = createSignal(true)
  const [spinnerFrame, setSpinnerFrame] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const [permissionMode, setPermissionMode] = createSignal<PermissionMode>("unknown")
  let mounted = false
  let previewSequence = 0
  let mouseSelection = false
  const peek = () => c.memory.peek && !!c.selectedSession()
  const promptSession = () => !composing() && !folderCursor() ? c.selectedSession() : undefined
  const promptLocation = () => promptSession()?.location ?? c.dispatchLocation()
  const promptAgentID = () => promptSession()?.agent ?? c.memory.agent
  const promptAgent = () => context.data.location.agent.list(promptLocation())?.find((agent) => agent.id === promptAgentID())
  const promptAgentName = () => promptAgent()?.name ?? promptAgentID() ?? "Default agent"
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
  const filtering = () => !peek() && /^[anso]:/i.test(c.memory.draft)
  const isTask = (value: string) => !peek() && !!value.trim() && !/^[anso]:/i.test(value)
  const composing = () => isTask(draft())
  const liveTask = () => isTask(input()?.plainText ?? draft())
  const liveFilter = () => !peek() && /^[anso]:/i.test(input()?.plainText ?? draft())
  const query = () => filtering() ? c.memory.draft : ""
  const allRows = createMemo(() => c.rows())
  const ageWidth = createMemo(() => Math.max(3, ...allRows().map((row) => sessionAge(row.session.time.created, now()).length)))
  const directories = createMemo(() => c.directories())
  const groups = createMemo(() => groupRows(allRows(), c.grouping(), query(), directories(), c.available(c.location().directory) ? c.location().directory : undefined))
  // Retain rendered group/row identities as summaries stream in. A fresh array
  // of plain objects otherwise makes <For> destroy and remount the entire list.
  const [renderGroups, setRenderGroups] = createStore<Group[]>([])
  createEffect(() => setRenderGroups(reconcile(groups().map((group) => ({
    ...group, rows: group.rows.map((row) => ({ ...row, id: row.session.id })),
  })))))
  const isCollapsed = (directory: string) => !filtering() && collapsed().has(directoryKey(directory))
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
  const selected = createMemo(() => folderCursor() ? undefined : rows().find((row) => row.session.id === c.memory.selected))
  const selectedID = () => composing() ? folderID(c.dispatchLocation().directory) :
    folderCursor() ? folderID(folderCursor()!) : c.memory.selected ? `agent-${c.memory.selected}` : undefined
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
  const stash = () => {
    const value = input()?.plainText ?? draft()
    if (!value.length) return
    c.updateMemory((memory) => { (memory.stashed ??= []).push(value) })
    updateDraft("")
    input()?.setText("")
  }
  const restoreStash = () => {
    const value = c.memory.stashed?.at(-1)
    if (value === undefined) return
    const current = input()?.plainText ?? draft()
    c.updateMemory((memory) => {
      memory.stashed!.pop()
      // Preserve any draft being replaced so it can be restored in turn.
      if (current.length) memory.stashed!.push(current)
    })
    updateDraft(value)
    input()?.setText(value)
    input()?.gotoBufferEnd()
  }
  const toggleFolder = (directory: string) => {
    if (filtering()) return
    // Toggling keeps the folder as the active keyboard and mouse target.
    setSelectionVisible(true)
    c.updateMemory((memory) => { memory.peek = false })
    setFolderCursor(directory)
    setCollapsed((current) => {
      const next = new Set(current)
      const key = directoryKey(directory)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const quit = () => context.keymap.dispatch("app.exit")
  const selectFolder = (directory: string) => {
    if (!liveTask()) return
    updateDraft(input()?.plainText ?? draft())
    // Keep the session cursor so clearing the task returns to that conversation.
    c.updateMemory((memory) => { memory.selectedDirectory = directory })
  }
  const move = (offset: number) => {
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
    if (target.directory) setFolderCursor(target.directory)
    else select(target.sessionID)
  }
  const attach = () => {
    const row = selected()
    if (row) c.attach(row.session.id)
  }
  const submit = async (attachImmediately = false) => {
    const value = input()?.plainText ?? draft()
    // Commit the live buffer before admission; content callbacks may still be
    // queued. The controller only clears this revision after a successful send.
    updateDraft(value)
    if (peek()) {
      const id = c.memory.selected
      if (id) await c.reply(id, value)
      return
    }
    if (/^[anso]:/i.test(value)) {
      updateDraft(value)
      const matches = groups().flatMap((group) => group.rows)
      const row = matches.find((row) => row.session.id === c.memory.selected) ?? matches[0]
      if (row) c.attach(row.session.id)
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
    c.clearStopConfirmation()
    if ((input()?.plainText ?? draft()).length) { input()?.setText(""); updateDraft(""); return }
    if (peek()) { c.updateMemory((memory) => { memory.peek = false }); return }
    c.back()
  }
  const chooseAgent = async () => {
    const response = await context.client.agent.list({ location: c.dispatchLocation() })
    const agent = await context.ui.dialog.select({
      title: "Dispatch agent", current: c.memory.agent ?? "",
      options: [{ title: "Default agent", value: "", description: "Use the configured OpenCode default" },
        ...response.data.filter((agent) => !agent.hidden).map((agent) => ({
          title: agent.name, value: agent.id, description: agent.description,
        }))],
    })
    if (agent !== undefined) c.updateMemory((memory) => { memory.agent = agent || null })
  }
  const chooseModel = async () => {
    const response = await context.client.model.list({ location: c.dispatchLocation() })
    const models = response.data
    const value = await context.ui.dialog.select({
      title: "Dispatch model", current: c.memory.model ? `${c.memory.model.providerID}/${c.memory.model.id}` : "",
      options: [{ title: "Default model", value: "", description: "Use the agent's configured model" },
        ...models.map((model) => ({ title: model.name, value: `${model.providerID}/${model.id}`, category: model.providerID }))],
    })
    if (value !== undefined) c.updateMemory((memory) => {
      const model = models.find((model) => `${model.providerID}/${model.id}` === value)
      memory.model = model ? { providerID: model.providerID, id: model.id } : null
      memory.modelInitialized = true
    })
  }
  const chooseFolder = async () => {
    if (!liveTask()) return
    updateDraft(input()?.plainText ?? draft())
    const current = directoryKey(c.dispatchLocation().directory)
    const directories = c.directories()
    const directory = await context.ui.dialog.select({
      title: "New session in folder", current: directories.find((path) => directoryKey(path) === current),
      options: directories.map((path) => ({
        title: context.ui.format.path(path), value: path,
        description: directoryKey(path) === directoryKey(c.location().directory) ? "Launch folder" : "Previously used folder",
      })),
    })
    if (directory !== undefined) {
      selectFolder(directory)
      input()?.focus()
    }
  }

  context.keymap.layer(() => {
    // OpenTUI batches content-change callbacks until rendering. Inspect the
    // buffer itself so fast typing/pasting cannot turn a space into Peek.
    const empty = () => (input()?.plainText ?? draft()).length === 0
    const rowCommand = (bind: string, title: string, action: (row: Row) => void | Promise<unknown>): KeymapCommand => ({
      bind, title, enabled: () => !!selected(), run: () => { const row = selected(); if (row) run(() => action(row)) },
    })
    return {
      mode: "agents-view", priority: 20, target: () => input(),
      commands: [
        { bind: "return", title: "Dispatch / attach / reply", run: () => run(() => submit()) },
        { bind: "ctrl+return", title: "Dispatch and attach", run: () => run(() => submit(true)) },
        { bind: "escape", title: "Close peek / clear / return", run: escape },
        { bind: "up", title: "Previous session / task folder", enabled: () => empty() || liveTask() || liveFilter(), run: () => move(-1) },
        { bind: "down", title: "Next session / task folder", enabled: () => empty() || liveTask() || liveFilter(), run: () => move(1) },
        { bind: "pageup", title: "Previous page", enabled: empty, run: () => move(-Math.max(1, dimensions().height - 12)) },
        { bind: "pagedown", title: "Next page", enabled: empty, run: () => move(Math.max(1, dimensions().height - 12)) },
        { bind: "home", title: "First session", enabled: empty, run: () => { const row = rows()[0]; if (row) select(row.session.id) } },
        { bind: "end", title: "Last session", enabled: empty, run: () => { const row = rows().at(-1); if (row) select(row.session.id) } },
        { bind: "right", title: "Attach", enabled: () => empty() || filtering(), run: () => run(attach) },
        { bind: "space", title: "Peek / reply", enabled: empty, run: () => {
          if (selected()) c.updateMemory((memory) => { memory.peek = !memory.peek })
        } },
        { bind: "ctrl+s", title: "Group by state / directory", run: () => run(c.toggleGrouping) },
        { bind: "ctrl+shift+s", title: "Stash draft", run: stash },
        { bind: "ctrl+alt+s", title: "Restore stashed draft", run: restoreStash },
        { bind: "alt+s", title: "Group by state / directory", run: () => run(c.toggleGrouping) },
        { bind: "ctrl+n", title: "Choose task folder", enabled: liveTask, run: () => run(chooseFolder) },
        rowCommand("ctrl+t", "Pin / unpin session", async (row) => {
          await c.togglePin(row.session.id)
          context.ui.toast.show({ message: row.pinned ? "Session unpinned" : "Session pinned" })
        }),
        rowCommand("ctrl+x", "Stop / hide session", (row) => c.stopOrHide(row.session.id)),
        rowCommand("ctrl+r", "Rename session", async (row) => {
          const value = await context.ui.dialog.prompt({ title: "Rename session", value: row.session.title })
          if (value?.trim()) await c.rename(row.session.id, value.trim())
        }),
        { bind: "ctrl+f", title: "Find session", run: () => {
          c.updateMemory((memory) => { memory.peek = false; memory.draft = "n:" })
          input()?.focus()
        } },
        { bind: "tab", title: "Choose dispatch agent", run: () => run(chooseAgent) },
        { bind: "ctrl+g", title: "Choose dispatch model", run: () => run(chooseModel) },
        { bind: "alt+m", title: "Choose dispatch model", run: () => run(chooseModel) },
        { bind: "ctrl+l", title: "Refresh sessions", run: () => run(c.refresh) },
        { bind: "ctrl+c", title: "Quit OpenCode", run: quit },
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
      if (!filtering() && groups().some((group) => group.directory === folderCursor())) return
      setFolderCursor(null)
    }
    // The detached conversation may arrive on a later inventory page. Preserve
    // that selection through initial loading or a failed inventory request.
    if (!filtering() && c.memory.selected && (c.loading() || c.error())) return
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
    if (id && box && !mouseSelection) queueMicrotask(() => { if (!box.isDestroyed) box.scrollChildIntoView(id) })
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
      `${list.filter((row) => row.state === "completed").length} completed`
  })
  return (
    <box width="100%" height="100%" paddingLeft={1} paddingRight={1} paddingTop={dimensions().height > 15 ? 1 : 0}
      gap={dimensions().height > 15 ? 1 : 0} backgroundColor={context.theme.background.base}>
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
          <text fg={context.theme.text.muted} wrapMode="none" truncate>
            {c.memory.model?.id ?? "Default model"} · {context.ui.format.path(c.location().directory)}
          </text>
        </Show>
        <text fg={context.theme.text.muted} wrapMode="none" truncate>{counts()}</text>
        <text fg={context.theme.text.muted} wrapMode="none" truncate>Group: {c.grouping() === "directory" ? "Folders" : "Status"} · Ctrl+S</text>
        </box>
      </box>
      <Show when={dimensions().height > 15}>
        <text fg={context.theme.text.muted} wrapMode="none" truncate>
          {c.memory.previous.type === "session" ? "Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c quits" : "Select a conversation — enter opens it · type a task, then ↑↓ to choose its folder · ctrl+c quits"}
        </text>
      </Show>
      <Show when={c.error()}><text fg={context.theme.text.feedback.error.base} wrapMode="none" truncate>Refresh failed: {oneLine(c.error())} · Ctrl+L retries</text></Show>
      <scrollbox ref={setScroll} flexGrow={1} minHeight={1} scrollX={false} contentOptions={{ gap: 1 }}>
        <Show when={groups().length && !c.loading()} fallback={<text fg={context.theme.text.muted}>
          {c.loading() ? "Loading sessions…" : filtering() ? "No matching sessions." : "Describe a task below to start your first agent."}
        </text>}>
          <For each={renderGroups}>{(group) => (
            <box>
              <text id={group.directory ? folderID(group.directory) : undefined} selectable={false}
                attributes={group.directory && folderSelected(group.directory) ? TextAttributes.BOLD : 0}
                fg={group.directory && folderSelected(group.directory) ? context.theme.text.base : context.theme.text.muted} wrapMode="none" truncate
                onMouseMove={() => { if (group.directory) hoverFolder(group.directory) }}
                onMouseUp={(event) => { if (event.button === 0 && group.directory) {
                  if (liveTask()) selectFolder(group.directory)
                  else toggleFolder(group.directory)
                  input()?.focus()
                } }}>
                {group.directory ? `${isCollapsed(group.directory) ? "▸" : "▾"} ${context.ui.format.path(group.directory)}` : group.title}
              </text>
              <For each={group.directory && isCollapsed(group.directory) ? [] : group.rows}>{(row) => (
                <box id={`agent-${row.session.id}`} flexDirection="row" gap={1} paddingLeft={1}
                  onMouseMove={() => hoverSession(row.session.id)}
                  onMouseUp={(event) => { if (event.button === 0 && !liveTask()) { select(row.session.id); c.attach(row.session.id) } }}>
                  <text selectable={false} fg={color(row.state)} width={1}>{row.state === "working" || row.state === "background-shell" ? SPINNER_FRAMES[spinnerFrame()] : ICON[row.state]}</text>
                  <text selectable={false} fg={selectionVisible() && !composing() && !folderCursor() && row.session.id === c.memory.selected ? context.theme.text.base : context.theme.text.muted}
                    attributes={selectionVisible() && !composing() && !folderCursor() && row.session.id === c.memory.selected ? TextAttributes.BOLD : 0}
                    width={Math.max(12, Math.min(32, Math.floor(dimensions().width * 0.3)))} flexShrink={0} wrapMode="none" truncate>
                    {oneLine(row.session.title || "current session")}
                  </text>
                  <Show when={dimensions().width > 50}>
                    <text selectable={false} fg={row.state === "working" ? context.theme.text.muted : color(row.state)} flexShrink={0}>{" "}{row.state === "idle" ? "Needs input" : STATE_LABEL[row.state]}</text>
                    <text selectable={false} flexGrow={1} flexShrink={1} minWidth={0} fg={context.theme.text.muted} wrapMode="none">
                      · {oneLine(row.summary || (row.state === "idle" ? "send a prompt to start" : STATE_LABEL[row.state])).replace(/^[▶▷▸]\s*/u, "")}
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
      <box id="agents-view-prompt" flexShrink={0} height={1}
        paddingLeft={1} paddingRight={1}
        onMouseUp={() => input()?.focus()}>
        <textarea id="agents-view-input" ref={setInput} initialValue={draft()} width="100%" height={1} minHeight={1} maxHeight={1}
          focusedTextColor={context.theme.text.base} textColor={context.theme.text.base}
          backgroundColor="transparent" focusedBackgroundColor="transparent" cursorColor={context.theme.text.base}
          placeholder={peek() ? "Reply, or → to attach" : "› Type a task to start an agent"}
          placeholderColor={context.theme.text.muted}
          keyBindings={[{ name: "return", shift: true, action: "newline" }, { name: "j", ctrl: true, action: "newline" }]}
          onContentChange={() => { const area = input(); if (area && !area.isDestroyed) updateDraft(area.plainText) }}
          onSubmit={() => run(() => submit())} />
      </box>
      <Show when={showShortcuts()} fallback={
        <text fg={context.theme.text.muted} wrapMode="none" flexShrink={0}>
          <span style={{ fg: promptAgentColor() }}>│ {promptAgentName()}</span>{" · "}
          {"ctrl+x stop / hide · ? for shortcuts · "}
          {peek() ? "enter to reply · → attach · esc close peek · ctrl+c quit" : composing() ? "enter to create · ↑↓ cycle folders · ctrl+n folders · esc clear · ctrl+c quit" : "↑↓ select · enter/click open or fold · space peek · ctrl+c quit"}
        </text>
      }>
        <box flexShrink={0} flexDirection="row" flexWrap="wrap" border={["top"]} borderColor={context.theme.border.base}>
          <For each={[
            [peek() ? "enter to reply" : "enter to create / open", "ctrl+r to rename"],
            ["ctrl+s to switch views", "ctrl+j for newline"],
            ["space to peek / reply", "ctrl+t to pin / unpin"],
            ["→ to attach", "ctrl+x to stop / hide"],
            ["tab to choose agent", "ctrl+g to choose model"],
            ["ctrl+c to quit", "? to close"],
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
