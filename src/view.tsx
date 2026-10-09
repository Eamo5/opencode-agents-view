import type { KeymapCommand } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import type { Controller } from "./controller.ts"
import { STATE_LABEL, directoryKey, messageSummary, oneLine, type AgentState, type Row } from "./model.ts"

const ICON: Record<AgentState, string> = {
  "needs-input": "*", working: "*", completed: "✓", failed: "×", stopped: "·", idle: "*",
}
const folderID = (directory: string) => `new-session-${directoryKey(directory)}`

export function AgentsView(props: { controller: Controller }) {
  const c = props.controller
  const context = c.context
  const dimensions = useTerminalDimensions()
  const [input, setInput] = createSignal<TextareaRenderable>()
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()
  const [previewLoading, setPreviewLoading] = createSignal(false)
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set())
  const [folderCursor, setFolderCursor] = createSignal<string | null>(null)
  const [selectionVisible, setSelectionVisible] = createSignal(true)
  let mounted = false
  let previewSequence = 0
  let mouseSelection = false
  const peek = () => c.memory.peek && !!c.selected()
  const draft = () => peek() ? c.memory.replies[c.memory.selected!] ?? "" : c.memory.draft
  const filtering = () => !peek() && /^[anso]:/i.test(c.memory.draft)
  const isTask = (value: string) => !peek() && !!value.trim() && !/^[anso]:/i.test(value)
  const composing = () => isTask(draft())
  const liveTask = () => isTask(input()?.plainText ?? draft())
  const query = () => filtering() ? c.memory.draft : ""
  const groups = createMemo(() => c.groups(query()))
  const isCollapsed = (directory: string) => !filtering() && collapsed().has(directoryKey(directory))
  const rows = createMemo(() => groups().flatMap((group) => group.directory && isCollapsed(group.directory) ? [] : group.rows))
  const targets = createMemo(() => groups().flatMap((group) => [
    ...(group.directory && !filtering() && !peek() ? [{ directory: group.directory, sessionID: "" }] : []),
    ...(group.directory && isCollapsed(group.directory) ? [] : group.rows.map((row) => ({ directory: "", sessionID: row.session.id }))),
  ]))
  const selected = createMemo(() => folderCursor() ? undefined : rows().find((row) => row.session.id === c.memory.selected))
  const selectedID = () => composing() ? folderID(c.dispatchLocation().directory) :
    folderCursor() ? folderID(folderCursor()!) : c.memory.selected ? `agent-${c.memory.selected}` : undefined
  const folderSelected = (directory: string) => composing() ?
    directoryKey(c.dispatchLocation().directory) === directoryKey(directory) : selectionVisible() && folderCursor() === directory
  const previewRows = () => /(^|\s)o:/i.test(query()) ? c.rows() : rows().slice(0, dimensions().height)
  const previewBatch = createMemo(() => previewRows().map((row) => `${row.session.id}:${row.session.time.updated}`).join("|"))
  const color = (state: AgentState) => state === "needs-input" || state === "idle" ? context.theme.text.feedback.warning.base :
    state === "working" ? context.theme.hue.accent[500] : state === "completed" ? context.theme.text.feedback.success.base :
      state === "failed" ? context.theme.text.feedback.error.base : context.theme.text.muted
  const updateDraft = (value: string) => c.updateMemory((memory) => {
    if (peek()) memory.replies[memory.selected!] = value
    else {
      // Capture the navigation target before composing clears the folder cursor.
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
  const select = (id: string | null) => { mouseSelection = false; setSelectionVisible(true); setFolderCursor(null); c.select(id) }
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
    setFolderCursor(null)
    updateDraft(input()?.plainText ?? draft())
    // Keep the session cursor so clearing the task returns to that conversation.
    c.updateMemory((memory) => { memory.selectedDirectory = directory })
  }
  const move = (offset: number) => {
    setSelectionVisible(true)
    mouseSelection = false
    if (liveTask()) {
      updateDraft(input()?.plainText ?? draft())
      const list = c.directories()
      if (!list.length) return
      const index = list.findIndex((directory) => directoryKey(directory) === directoryKey(c.dispatchLocation().directory))
      selectFolder(list[((index < 0 ? 0 : index) + offset % list.length + list.length) % list.length])
      return
    }
    const list = targets()
    if (!list.length) return
    const index = list.findIndex((target) => folderCursor() ? target.directory === folderCursor() : target.sessionID === c.memory.selected)
    const target = list[Math.max(0, Math.min(list.length - 1, index + offset))]
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
        { bind: "up", title: "Previous session / task folder", enabled: () => empty() || liveTask(), run: () => move(-1) },
        { bind: "down", title: "Next session / task folder", enabled: () => empty() || liveTask(), run: () => move(1) },
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
        rowCommand("ctrl+t", "Pin session", (row) => c.togglePin(row.session.id)),
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
        { bind: "alt+m", title: "Choose dispatch model", run: () => run(chooseModel) },
        { bind: "ctrl+l", title: "Refresh sessions", run: () => run(c.refresh) },
        { bind: "ctrl+c", title: "Quit OpenCode", run: quit },
        { bind: "?", title: "Keyboard shortcuts", enabled: empty, run: () => run(() => context.ui.dialog.alert({
          title: "Agents view shortcuts",
          message: "Empty prompt: ↑/↓ or mouse hover selects sessions and folders\nEnter or click: open session / collapse or expand folder\n→ attach · Space peek/reply\nType a task first, then ↑/↓ cycle target folders (wraps)\nWhile composing: hover/click a folder heading or Ctrl+N to choose a folder\nEnter dispatches · Ctrl+Enter dispatches and attaches\nShift+Enter or Ctrl+J newline · Ctrl+F find\nCtrl+S arrange by folders or status (Pinned / Needs action / Working / Completed)\nCtrl+Shift+S stash draft · Ctrl+Alt+S restore stash\nAlt+S also groups · Ctrl+T pin · Ctrl+R rename\nCtrl+X stop, twice within 2s hide · /resume restore hidden\nTab choose agent · Alt+M choose model · Ctrl+L refresh\nEsc clears the task and restores session selection, then returns\nCtrl+C quits OpenCode · In a session: ← on an empty/whitespace prompt returns here\nFilters: n:name, a:agent, s:state, o:output",
        })) },
      ],
    }
  })

  createEffect(() => c.syncInitialModel())
  createEffect(() => {
    if (!composing() && c.memory.selectedDirectory) c.updateMemory((memory) => { memory.selectedDirectory = null })
    if (composing()) {
      if (folderCursor() && !c.memory.selectedDirectory) {
        const directory = folderCursor()!
        c.updateMemory((memory) => { memory.selectedDirectory = directory })
      }
      setFolderCursor(null)
    }
  })
  createEffect(() => {
    const list = rows()
    if (folderCursor()) {
      if (!filtering() && groups().some((group) => group.directory === folderCursor())) return
      setFolderCursor(null)
    }
    // The detached conversation may arrive on a later inventory page. Preserve
    // that selection through initial loading or a failed inventory request.
    if (!filtering() && c.memory.selected && (c.loading() || c.error())) return
    if (composing()) return
    const containing = groups().find((group) => group.directory && isCollapsed(group.directory) &&
      group.rows.some((row) => row.session.id === c.memory.selected))
    if (containing?.directory) {
      setFolderCursor(containing.directory)
      return
    }
    if (!list.some((row) => row.session.id === c.memory.selected)) {
      if (list.length) select(list[0].session.id)
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
    const pop = context.keymap.mode.push("agents-view")
    input()?.focus()
    void c.refresh()
    onCleanup(() => { mounted = false; pop() })
  })

  const counts = createMemo(() => {
    const list = c.rows()
    return `${list.filter((row) => row.state === "needs-input" || row.state === "idle").length} awaiting input · ` +
      `${list.filter((row) => row.state === "working").length} working · ` +
      `${list.filter((row) => row.state === "completed").length} completed`
  })
  return (
    <box width="100%" height="100%" paddingLeft={1} paddingRight={1} paddingTop={dimensions().height > 15 ? 1 : 0}
      gap={dimensions().height > 15 ? 1 : 0} backgroundColor={context.theme.background.base}>
      <box flexShrink={0} flexDirection="row" gap={2}>
        <Show when={dimensions().width >= 30 && dimensions().height > 15}>
          {/* Terminal rendering of opencode.ai/favicon.svg: tall O, shaded lower inset. */}
          <box width={8} flexShrink={0}>
            <text selectable={false} fg={context.theme.text.base}>████████</text>
            <text selectable={false} fg={context.theme.text.base}>{"██    ██"}</text>
            <text selectable={false} fg={context.theme.text.base}>██<span style={{ fg: context.theme.text.muted }}>████</span>██</text>
            <text selectable={false} fg={context.theme.text.base}>██<span style={{ fg: context.theme.text.muted }}>████</span>██</text>
            <text selectable={false} fg={context.theme.text.base}>████████</text>
          </box>
        </Show>
        <box flexGrow={1} minWidth={0}>
        <text fg={context.theme.text.base}>OpenCode v{context.app.version} · Agents</text>
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
          <For each={groups()}>{(group) => (
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
                  <text selectable={false} fg={color(row.state)} width={1}>{ICON[row.state]}</text>
                  <text selectable={false} fg={selectionVisible() && !composing() && !folderCursor() && row.session.id === c.memory.selected ? context.theme.text.base : context.theme.text.muted}
                    attributes={selectionVisible() && !composing() && !folderCursor() && row.session.id === c.memory.selected ? TextAttributes.BOLD : 0}
                    width={Math.max(12, Math.min(32, Math.floor(dimensions().width * 0.3)))} flexShrink={0} wrapMode="none" truncate>
                    {oneLine(row.session.title || "current session")}
                  </text>
                  <Show when={dimensions().width > 50}>
                    <text selectable={false} fg={color(row.state)} flexShrink={0}>{row.state === "idle" ? "Needs input" : STATE_LABEL[row.state]}</text>
                    <text selectable={false} flexGrow={1} flexShrink={1} minWidth={0} fg={context.theme.text.muted} wrapMode="none" truncate>
                      · {oneLine(row.summary || (row.state === "idle" ? "send a prompt to start" : STATE_LABEL[row.state]))}
                    </text>
                  </Show>
                </box>
              )}</For>
            </box>
          )}</For>
        </Show>
      </scrollbox>
      <Show when={peek() && selected()}>{(row) => (
        <box border borderColor={context.theme.border.base} paddingLeft={1} paddingRight={1}
          maxHeight={Math.max(4, Math.floor(dimensions().height / 3))} flexShrink={0}>
          <text fg={color(row().state)} wrapMode="none" truncate>
            {STATE_LABEL[row().state]} · {oneLine(row().session.title ?? "New session")}
          </text>
          <scrollbox flexGrow={1} minHeight={1} scrollX={false}>
            <text fg={context.theme.text.base}>
              {oneLine(messageSummary(c.messages(row().session.id)) || row().summary || (previewLoading() ? "Loading recent output…" : "No output yet."))}
            </text>
            <Show when={row().state === "needs-input"}>
              <text fg={context.theme.text.feedback.warning.base}>
                {oneLine(row().summary)} · Press → to answer the permission or form in the session.
              </text>
            </Show>
          </scrollbox>
        </box>
      )}</Show>
      <box flexShrink={0}>
        <Show when={peek() || draft().length > 0 || c.memory.selectedDirectory || c.sending()}>
          <text fg={context.theme.text.muted} wrapMode="none" truncate>{c.sending() ? "Sending…" : peek() ? "Reply to selected agent" : filtering() ? "Filter sessions" : `New task · ${context.ui.format.path(c.dispatchLocation().directory)}`}</text>
        </Show>
        <textarea id="agents-view-input" ref={setInput} initialValue={draft()} width="100%" minHeight={1}
          maxHeight={Math.max(1, Math.min(6, Math.floor(dimensions().height / 4)))}
          focusedTextColor={context.theme.text.base} textColor={context.theme.text.base}
          backgroundColor="transparent" focusedBackgroundColor="transparent" cursorColor={context.theme.text.base}
          placeholder={peek() ? "Reply, or → to attach" : "› Type a task to start an agent"}
          placeholderColor={context.theme.text.muted}
          keyBindings={[{ name: "return", shift: true, action: "newline" }, { name: "j", ctrl: true, action: "newline" }]}
          onContentChange={() => { const area = input(); if (area && !area.isDestroyed) updateDraft(area.plainText) }}
          onSubmit={() => run(() => submit())} />
      </box>
      <text fg={context.theme.text.muted} wrapMode="none" truncate flexShrink={0}>
        {composing() ? "↑↓ cycle folders · enter dispatch · ctrl+n folders · esc clear · ctrl+c quit" : "↑↓ select · enter/click open or fold · space peek · ctrl+c quit"}
      </text>
    </box>
  )
}
