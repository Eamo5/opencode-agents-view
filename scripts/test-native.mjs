import assert from "node:assert/strict"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createComponent, createElement, insert, render, setProp } from "@opentui/solid"
import { Show, createComputed, createContext, createMemo, createSignal, onCleanup, onMount, useContext } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Host as PluginHost } from "@opencode/plugin/host"
import { createPluginSources } from "@opencode/plugin/source"
import { fileURLToPath } from "node:url"

// Load through the same local-directory resolution path as the installed CLI,
// not a direct dist import that bypasses entrypoint discovery.
const sources = createPluginSources(async () => {})
const entrypoint = PluginHost.resolve({ directory: fileURLToPath(new URL("../", import.meta.url)) }).tui
assert.ok(entrypoint, "OpenCode discovers the installed local TUI")
const { module: { default: plugin } } = await sources.read(entrypoint)
assert.equal(plugin.id, "agents.view")

// Exercise compiled JSX, actual native rendering and real keyboard dispatch.
// The API is deterministic and deliberately never contacts a model provider.
const test = await createTestRenderer({ width: 100, height: 28, kittyKeyboard: true })
const keymap = createDefaultOpenTuiKeymap(test.renderer)
const KeymapContext = createContext()
const [mounted, setMounted] = createSignal(true)
let activeLayers = 0
const [route, setRoute] = createStore({ type: "home" })
const [modes, setModes] = createSignal([])
const [currentModel, setCurrentModel] = createSignal(undefined)
const mode = createMemo(() => modes().at(-1)?.name ?? "base")
const unregisterMode = keymap.registerLayerFields({ mode(value, context) { context.require("mode", value) } })
const pages = new Map()
const slots = []
const stores = new Map()
const toasts = []
const prompts = []
const commands = []
const completionLocations = []
const skills = [{ id: "test-skill", name: "Test skill", description: "Test skill instructions", path: "/skills/test/SKILL.md", content: "Test" }]
const modelLocations = []
const modelSwitches = []
const agentLocations = []
const dispatchedCommands = []
const color = RGBA.fromHex("#abcdef")
const feedback = { warning: { base: color }, error: { base: color }, success: { base: color } }
const theme = { text: { base: color, muted: color, feedback }, background: { base: RGBA.fromHex("#000000"), raised: { base: color } }, hue: { accent: { 500: color } }, categorical: [{ 200: RGBA.fromHex("#3b82f6") }], border: { base: color } }
const session = (id, overrides = {}) => ({
  id, title: id, projectID: "project", agent: "build", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: Date.now() - 10000, updated: Date.now() }, location: { directory: "/project" }, ...overrides,
})
const sessions = [session("running", { model: { providerID: "acme", id: "running-model" } }),
  session("finished", { outcome: "succeeded", agent: "plan", model: { providerID: "acme", id: "finished-model" } })]
const shells = []
let releaseInventory
const inventoryReady = new Promise((resolve) => { releaseInventory = resolve })
let recentOutput = "Recent output from the agent"
let recalledPrompts
let cleanup
let interruptions = 0
const storage = (key, options) => {
  if (!stores.has(key)) {
    const [state, update] = createStore(structuredClone(options.initial))
    stores.set(key, [state, (mutation) => { update(produce(mutation)); return Promise.resolve() }])
  }
  return stores.get(key)
}
const context = {
  options: { defaultToAgentsView: true }, app: { version: "2.0.26", channel: "test" },
  renderer: test.renderer, theme, location: { directory: "/project" },
  storage: { store: storage, memory: storage },
  client: {
    agent: { list: async ({ location }) => {
      agentLocations.push(location)
      return { data: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] }
    } },
    skill: { list: async ({ location }) => { completionLocations.push(location.directory); return { data: skills } } },
    model: { list: async ({ location }) => {
      modelLocations.push(location)
      return { data: [{ providerID: "acme", id: "chosen", name: "Chosen model" }] }
    } },
    location: { get: async () => ({ directory: "/project", project: { id: "project" } }) },
    debug: { location: { list: async () => [{ directory: "/project" }] } },
    shell: { list: async () => ({ data: [...shells] }) },
    session: {
      switchModel: async (input) => {
        modelSwitches.push(input)
        const target = sessions.find((item) => item.id === input.sessionID)
        target.model = input.model
        target.time.updated++
      },
      list: async () => { await inventoryReady; return { data: sessions, cursor: {} } }, active: async () => ({ running: { type: "running" } }),
      create: async (input) => { const value = session(`new-${sessions.length}`, input); sessions.push(value); return value },
      prompt: async (input) => { prompts.push(input) },
      command: async (input) => { commands.push(input) },
      interrupt: async () => { interruptions++; return { interrupted: true } },
    },
    message: { list: async ({ sessionID, type, limit }) => type === "user" && limit === 1 ? {
      data: [{ id: `${sessionID}-latest`, type: "user", text: `${sessionID} latest prompt`, time: { created: sessionID === "running" ? 2 : 1 } }], cursor: {},
    } : type === "user" ? {
      data: recalledPrompts?.map((text, index) => ({ id: `history-${index}`, type: "user", text, time: { created: recalledPrompts.length - index } })) ?? [{ id: "user-2", type: "user", text: `${sessionID} latest prompt`, time: { created: 2 } },
        { id: "user-1", type: "user", text: `${sessionID} earlier prompt`, time: { created: 1 } }], cursor: {},
    } : ({ data: [{ id: "m", type: "assistant", time: { created: 1 }, content: [{ type: "text", text: recentOutput }] }], cursor: {} }) },
    permission: { request: { list: async () => ({ data: [] }) } }, form: { list: async () => ({ data: [] }) },
  },
  data: {
    listen: () => () => {}, location: {
      default: () => ({ directory: "/project" }),
      agent: { list: () => [{ id: "build", name: "Build", color: "#abcdef" }, { id: "plan", name: "Plan", color: "#fedcba" }], sync: async () => {} },
      command: { list: (location) => [{ name: "review", description: `Review in ${location.directory}` }, { name: "release", description: "Release changes" }], sync: async ({ directory }) => { completionLocations.push(directory) } },
      skill: { list: () => skills, sync: async ({ directory }) => { completionLocations.push(directory) } },
    },
    session: { list: () => [], get: () => undefined, family: () => [], status: () => "idle", message: { list: () => [] }, permission: { list: () => [] }, form: { list: () => [] } },
  },
  ui: {
    router: {
      register: (page) => { pages.set(page.name, page); return () => pages.delete(page.name) },
      current: () => route,
      navigate: (next) => setRoute(reconcile(next.type === "plugin" ? { ...next, id: plugin.id } : next)),
    },
    slot: (slot) => { slots.push(slot); return () => {} },
    format: { path: (value) => value }, model: { current: currentModel },
    dialog: { clear() {}, alert: async () => {} }, toast: { show: (value) => toasts.push(value) }, tabs: { open() {} },
  },
  keymap: {
    commands: () => [{ id: "test.settings", title: "Test settings", slash: { name: "test-settings", aliases: ["test-config"] }, run() {} }],
    dispatch: (command) => { dispatchedCommands.push(command) },
    mode: { current: mode, push: (name) => {
      const id = Symbol()
      setModes((items) => [...items, { name, id }])
      return () => setModes((items) => items.filter((item) => item.id !== id))
    } },
    layer(factory) {
      // Older V2 hosts expose createLayer directly: setup has no Solid owner,
      // so only mounted contributions can resolve the host keymap provider.
      if (!useContext(KeymapContext)) throw new Error("Keymap.Provider is missing")
      // Match the host's public-context adapter, including scope disposal.
      createComputed(() => {
        const layer = factory()
        const commands = layer.commands ?? []
        const target = layer.target?.()
        if (layer.target && !target) return
        const dispose = keymap.registerLayer({
          priority: layer.priority, target, enabled: layer.enabled,
          ...(layer.mode === "global" ? {} : { mode: layer.mode ?? "base" }),
          commands: commands.filter((command) => command.id).map((command) => ({
            name: command.id, enabled: command.enabled, run: (event) => command.run(undefined, event.event),
          })),
          bindings: commands.filter((command) => typeof command.bind === "string").map((command) => ({
            key: command.bind,
            cmd: command.id ?? (() => {
              if (command.enabled === false || (typeof command.enabled === "function" && !command.enabled())) return false
              return command.run()
            }),
          })),
        })
        activeLayers++
        onCleanup(() => { activeLayers--; dispose() })
      })
    },
  },
}
function SessionPrompt() {
  const area = createElement("textarea")
  setProp(area, "id", "session-input")
  setProp(area, "height", 3)
  onMount(() => area.focus())
  return area
}
function PluginUI() {
  createComputed(() => keymap.setData("mode", mode()))
  const box = createElement("box")
  setProp(box, "height", "100%")
  setProp(box, "width", "100%")
  setProp(box, "flexDirection", "column")
  // Mirror the host's flex-grown route containers rather than mounting the
  // dashboard directly under a fixed-size box.
  const row = createElement("box")
  setProp(row, "flexGrow", 1)
  setProp(row, "minHeight", 0)
  setProp(row, "flexDirection", "row")
  const column = createElement("box")
  setProp(column, "flexGrow", 1)
  setProp(column, "minWidth", 0)
  setProp(column, "flexDirection", "column")
  const content = createElement("box")
  setProp(content, "flexGrow", 1)
  setProp(content, "minHeight", 0)
  setProp(content, "flexDirection", "column")
  insert(content, () => route.type === "plugin" ? pages.get(route.name).render({}) : createComponent(SessionPrompt, {}))
  insert(column, () => [content, ...slots.filter((slot) => slot.append === "app").map((slot) => slot.render({}))])
  insert(row, column)
  insert(box, row)
  return box
}
function Host() {
  return createComponent(KeymapContext.Provider, {
    value: keymap,
    get children() {
      return createComponent(Show, {
        get when() { return mounted() },
        get children() { return createComponent(PluginUI, {}) },
      })
    },
  })
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 25))
  await test.flush()
}
function assertFooterAtBottom(label) {
  const view = test.renderer.root.findDescendantById("agents-view")
  const footer = test.renderer.root.findDescendantById("agents-view-status")
  assert.ok(view && footer, `${label}: view and status footer are mounted`)
  assert.equal(footer.height, 1, `${label}: status footer is exactly one line tall`)
  assert.equal(footer.y + footer.height, view.y + view.height, `${label}: status footer occupies the bottom row`)
  assert.equal(footer.y + footer.height, test.renderer.root.height, `${label}: status footer reaches the terminal bottom`)
  const bottomLine = test.captureCharFrame().split("\n")[test.renderer.root.height - 1]
  assert.match(bottomLine, /ctrl\+x/, `${label}: status text is rendered on the last terminal row`)
}
try {
  // The real plugin loader invokes setup outside the mounted component tree.
  cleanup = await plugin.setup(context)
  assert.equal(activeLayers, 0, "setup does not require a mounted keymap provider")
  await render(Host, test.renderer)
  await flush()
  assert.equal(route.type, "plugin", "default landing route")
  assert.match(test.captureCharFrame(), /Agents/)
  assert.match(test.captureCharFrame(), /Loading sessions/)
  setCurrentModel({ providerID: "acme", modelID: "preferred", variant: "high" })
  await flush()
  assert.deepEqual(stores.get("navigation")[0].model, { providerID: "acme", id: "preferred", variant: "high" }, "late-loading prompt model hydrates the initial dispatch selection")
  assert.match(test.captureCharFrame(), /preferred/, "header shows the model that will be dispatched")
  context.ui.router.navigate({ type: "session", sessionID: "finished" })
  await flush()
  test.mockInput.pressArrow("left")
  await flush()
  assert.equal(stores.get("navigation")[0].selected, "finished", "detaching before inventory loads preserves the origin")
  releaseInventory()
  await flush()
  assert.equal(stores.get("navigation")[0].selected, "finished", "inventory arrival keeps the originating row selected")
  assert.match(test.captureCharFrame(), /^\s*Plan · ctrl\+x/m, "status shows the selected chat's agent without opening peek")
  assert.match(test.captureCharFrame(), /finished-model · \/project/, "header shows the selected session's model instead of the startup model")
  assertFooterAtBottom("normal dashboard")
  for (const [width, height] of [[100, 27], [120, 26], [80, 25], [80, 24], [40, 12], [100, 28]]) {
    test.resize(width, height)
    await flush()
    assertFooterAtBottom(`normal dashboard ${width}×${height}`)
    test.mockInput.pressKey(" ")
    await flush()
    assertFooterAtBottom(`peek ${width}×${height}`)
    test.mockInput.pressEscape()
    await flush()
    assertFooterAtBottom(`closed peek ${width}×${height}`)
  }
  test.mockInput.pressArrow("up")
  await flush()
  assert.equal(stores.get("navigation")[0].selected, "running")
  assert.match(test.captureCharFrame(), /^\s*Build · ctrl\+x/m, "navigating to another chat updates the status agent")
  assert.match(test.captureCharFrame(), /running-model · \/project/, "navigating between sessions updates the header model")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  test.mockInput.pressArrow("down")
  await flush()
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.equal(stores.get("navigation")[0].selected, "finished")
  assert.match(test.captureCharFrame(), /2 selected/)
  assert.match(test.captureCharFrame(), /finished-model · \/project/, "with chats highlighted, the header shows the cursor chat's model")
  test.mockInput.pressArrow("left", { shift: true })
  await flush()
  test.mockInput.pressArrow("up")
  await flush()
  assert.equal(stores.get("navigation")[0].selected, "running")
  test.mockInput.pressKey(" ")
  await flush()
  await test.mockInput.typeText("reply to the current session")
  await flush()
  assert.match(test.captureCharFrame(), /running-model · \/project/, "typing a peek reply keeps the existing session model")
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressEscape()
  await flush()
  await test.mockInput.typeText("a new task")
  await flush()
  assert.match(test.captureCharFrame(), /preferred · \/project/, "composing a task shows the new-session model")
  test.mockInput.pressEscape()
  await flush()
  assert.match(test.captureCharFrame(), /running-model · \/project/, "cancelling a task restores the selected session model")
  const cachedMessages = context.data.session.message.list
  context.data.session.message.list = (id) => id === "running" ? [{
    id: "resolved-model", type: "assistant", time: { created: Date.now() }, content: [],
    model: { providerID: "acme", id: "resolved-model" },
  }] : []
  sessions[0] = { ...sessions[0], model: undefined }
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.match(test.captureCharFrame(), /resolved-model · \/project/, "defaulted sessions show the model resolved on their latest assistant message")
  context.data.session.message.list = cachedMessages
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.match(test.captureCharFrame(), /Default model · \/project/, "a session without model information never borrows the startup dispatch model")
  const cachedAgents = context.data.location.agent.list
  context.data.location.agent.list = (...args) => cachedAgents(...args).map((agent) => ({
    ...agent, model: { providerID: "acme", id: "agent-default" },
  }))
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.match(test.captureCharFrame(), /agent-default · \/project/, "sessions without an override or output use their agent's configured model")
  const dispatchAgent = stores.get("navigation")[0].agent
  await stores.get("navigation")[1]((draft) => { draft.agent = "build"; draft.model = null; draft.modelInitialized = true })
  await test.mockInput.typeText("use the agent default")
  await flush()
  assert.match(test.captureCharFrame(), /agent-default · \/project/, "an explicit default dispatch model resolves to the selected agent's model")
  await stores.get("navigation")[1]((draft) => { draft.agent = dispatchAgent; draft.model = { providerID: "acme", id: "preferred", variant: "high" } })
  test.mockInput.pressEscape()
  await flush()
  context.data.location.agent.list = cachedAgents
  sessions[0] = { ...sessions[0], agent: "plan", model: { providerID: "acme", id: "updated-model" } }
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.match(test.captureCharFrame(), /^\s*Plan · ctrl\+x/m, "a refreshed session agent updates the status without changing selection")
  assert.match(test.captureCharFrame(), /updated-model · \/project/, "a refreshed session model updates without changing selection")
  sessions[0] = { ...sessions[0], agent: "build" }
  test.mockInput.pressKey("l", { ctrl: true })
  test.mockInput.pressArrow("down")
  await flush()
  assert.match(test.captureCharFrame(), /Working/)
  test.mockInput.pressKey("?")
  await flush()
  assert.match(test.captureCharFrame(), /\? to close/, "shortcut help expands inline")
  assert.match(test.captureCharFrame(), /ctrl\+x to stop \/ hide/)
  assert.match(test.captureCharFrame(), /Working/, "inline help keeps the session list visible")
  test.mockInput.pressKey("?")
  await flush()
  assert.doesNotMatch(test.captureCharFrame(), /\? to close/, "question mark closes inline help")
  assert.match(test.captureCharFrame(), /\? for shortcuts/)
  assert.equal(stores.get("navigation")[0].draft, "", "closing help consumes the question mark")
  assertFooterAtBottom("closed shortcut help")
  const promptInput = test.renderer.currentFocusedEditor
  const wrappedDraft = "x".repeat(promptInput.width - 1) + " next line"
  await test.mockInput.typeText(wrappedDraft)
  await flush()
  assert.ok(promptInput.height > 1, "prompt grows when typing wraps past the terminal width")
  assert.equal(promptInput.plainText, wrappedDraft, "soft wrapping preserves the original draft")
  assertFooterAtBottom("wrapped task draft")
  assert.match(test.captureCharFrame(), /x{20}/, "the first wrapped line stays visible")
  assert.match(test.captureCharFrame(), /next line/, "the continuation stays visible")
  test.resize(60, 28)
  await flush()
  assert.ok(promptInput.height > 1, "prompt reflows after narrowing the terminal")
  assert.equal(promptInput.plainText, wrappedDraft, "resizing preserves the draft")
  test.mockInput.pressEscape()
  await flush()
  assert.equal(promptInput.height, 1, "clearing the draft collapses the prompt")
  await test.mockInput.typeText("first line")
  test.mockInput.pressKey("j", { ctrl: true })
  await test.mockInput.typeText("second line")
  await flush()
  assert.equal(promptInput.plainText, "first line\nsecond line")
  assert.equal(promptInput.height, 2, "explicit newlines grow the prompt")
  assert.match(test.captureCharFrame(), /first line/)
  assert.match(test.captureCharFrame(), /second line/)
  promptInput.insertText("\nextra line".repeat(20))
  promptInput.gotoBufferEnd()
  await flush()
  assert.ok(promptInput.height <= 9, "long drafts leave room for the session list")
  assert.match(test.captureCharFrame(), /Working/, "the session list remains visible with a long draft")
  test.resize(40, 12)
  await flush()
  assert.ok(promptInput.height <= 4, "prompt height adapts to short terminals")
  assert.ok(promptInput.y + promptInput.height < 12, "short terminals keep the prompt and footer on screen")
  assertFooterAtBottom("multiline draft in a short terminal")
  test.mockInput.pressEscape()
  test.resize(100, 28)
  await flush()
  test.mockInput.pressKey("?")
  await flush()
  await test.mockInput.typeText("draft task")
  await flush()
  test.mockInput.pressKey("?")
  await flush()
  assert.doesNotMatch(test.captureCharFrame(), /\? to close/, "help also closes while composing")
  assert.equal(stores.get("navigation")[0].draft, "draft task", "closing help preserves the draft")
  test.mockInput.pressKey("?")
  await flush()
  assert.equal(stores.get("navigation")[0].draft, "draft task?", "question marks remain usable with help closed")
  test.mockInput.pressEscape()
  await flush()
  assert.equal(stores.get("preferences")[0].grouping, "directory", "folder-first default")
  assert.doesNotMatch(test.captureCharFrame(), /New session ·/, "no duplicated per-folder action rows")
  assert.match(test.captureCharFrame(), /Done/)
  shells.push({ id: "server", status: "running", command: "npm run dev", metadata: { sessionID: "finished" } })
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.match(test.captureCharFrame(), /Background shell/, "finished agents with live shells stay visibly active")
  assert.match(test.captureCharFrame(), /npm run dev/, "background shell summary shows its command")
  assert.match(test.captureCharFrame(), /1 background shell/, "header counts background-shell sessions")
  shells.length = 0
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.doesNotMatch(test.captureCharFrame(), /Background shell/, "exited shells clear the background state")
  assert.match(test.captureCharFrame(), /Done/)
  assert.match(test.captureCharFrame(), /running/)
  const runningLines = test.captureCharFrame().split("\n")
  const runningY = runningLines.findIndex((line) => line.includes("running"))
  await test.mockMouse.moveTo(runningLines[runningY].indexOf("running"), runningY)
  await flush()
  assert.equal(stores.get("navigation")[0].selected, "running", "selection follows mouse hover without attaching")
  assert.equal(route.type, "plugin")
  test.mockInput.pressKey("t", { ctrl: true })
  await flush()
  assert.ok(stores.get("preferences")[0].pinned.includes("running"), "Ctrl+T pins the selected chat")
  assert.doesNotMatch(test.captureCharFrame(), /\[pinned\]/, "Pinned section replaces inline labels")
  const pinnedFrame = test.captureCharFrame()
  assert.ok(pinnedFrame.indexOf("Pinned") < pinnedFrame.indexOf("▾ /project"), "Pinned section precedes folders")
  assert.equal(pinnedFrame.split("\n").filter((line) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] running\s/.test(line)).length, 1, "pinned chat is not duplicated in its folder")
  test.mockInput.pressKey("t", { ctrl: true })
  await flush()
  assert.ok(!stores.get("preferences")[0].pinned.includes("running"), "Ctrl+T toggles pin off")
  assert.doesNotMatch(test.captureCharFrame(), /\[pinned\]/)
  await test.mockInput.typeText("n:")
  test.mockInput.pressArrow("up")
  await flush()
  assert.equal(stores.get("navigation")[0].selected, "finished", "Up navigates filtered sessions even before the input callback flushes")
  test.mockInput.pressArrow("down")
  await flush()
  assert.equal(stores.get("navigation")[0].selected, "running", "Down navigates filtered sessions")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "n:")
  test.mockInput.pressEscape()
  await flush()
  await test.mockInput.typeText("preserve this unsent task")
  for (const grouping of ["state", "directory"]) {
    test.mockInput.pressKey("s", { ctrl: true })
    await flush()
    assert.equal(stores.get("preferences")[0].grouping, grouping, "Ctrl+S arranges the agents panel")
    assert.equal(test.renderer.currentFocusedEditor.plainText, "preserve this unsent task", "grouping preserves the draft")
    assert.match(test.captureCharFrame(), /finished/)
  }
  test.mockInput.pressEscape()
  await flush()
  const clickText = async (text) => {
    const lines = test.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    assert.ok(y >= 0, `click target exists: ${text}`)
    await test.mockMouse.click(lines[y].indexOf(text), y)
    await flush()
  }
  await clickText("▾ /project")
  assert.match(test.captureCharFrame(), /▸ \/project · 1 working/)
  assert.doesNotMatch(test.captureCharFrame(), /running/, "clicking a folder hides its sessions")
  test.mockInput.pressEnter()
  await flush()
  assert.match(test.captureCharFrame(), /running/, "Enter expands the selected folder")
  test.mockInput.pressKey(" ")
  await flush()
  assert.match(test.captureCharFrame(), /▸ \/project · 1 working/)
  assert.doesNotMatch(test.captureCharFrame(), /running/, "Space collapses the selected folder")
  assert.equal(stores.get("navigation")[0].peek, false, "Space on a folder does not open session peek")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "", "Space on a folder leaves the prompt empty")
  test.mockInput.pressKey(" ")
  await flush()
  assert.match(test.captureCharFrame(), /running/, "Space expands the same selected folder")
  await test.mockInput.typeText("folder task")
  test.mockInput.pressKey(" ")
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "folder task ", "Space in a folder task remains ordinary input")
  assert.match(test.captureCharFrame(), /▾ \/project/, "typing a space does not collapse the task folder")
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressKey("HOME")
  test.mockInput.pressArrow("up")
  test.mockInput.pressEnter()
  await flush()
  assert.doesNotMatch(test.captureCharFrame(), /running/, "keyboard reaches and collapses the heading")
  context.ui.router.navigate({ type: "session", sessionID: "finished" })
  await flush()
  test.mockInput.pressArrow("left")
  await flush()
  assert.match(test.captureCharFrame(), /▸ \/project · 1 working/, "collapsed folders survive leaving and reopening the dashboard")
  assert.doesNotMatch(test.captureCharFrame(), /running/, "returning to a collapsed folder keeps its sessions folded")
  const listForms = context.client.form.list
  context.client.form.list = async () => ({ data: [{ id: "pending", sessionID: "finished", title: "Choose an option", fields: [{ type: "string", key: "answer", title: "Which option?" }] }] })
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.match(test.captureCharFrame(), /▸ \/project · 1 needs input · 1 working/, "collapsed counts update when a session needs attention")
  context.client.form.list = listForms
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.match(test.captureCharFrame(), /▸ \/project · 1 working/, "resolved requests leave the collapsed count")
  await test.mockInput.typeText("n:running")
  await flush()
  assert.match(test.captureCharFrame(), /Working/, "filtering expands collapsed matches")
  test.mockInput.pressEscape()
  await flush()
  await clickText("▸ /project")
  await clickText("finished")
  assert.equal(route.type, "session", "single-click opens a session")
  test.mockInput.pressArrow("left")
  await flush()
  recentOutput = "Recent output now includes live progress"
  const rowBeforeRefresh = test.renderer.root.findDescendantById("agent-running")
  assert.ok(rowBeforeRefresh)
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.match(test.captureCharFrame(), /live progress/, "working summaries update without an inventory timestamp change")
  assert.equal(test.renderer.root.findDescendantById("agent-running"), rowBeforeRefresh, "preview updates reuse the rendered row instead of rebuilding the list")
  assert.doesNotMatch(test.captureCharFrame(), /Last full sync/)
  const listSessions = context.client.session.list
  context.client.session.list = async () => { throw new Error("Server offline") }
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.match(test.captureCharFrame(), /Refresh failed: Server offline/, "a full refresh outage is visible")
  assert.match(test.captureCharFrame(), /running/, "a full outage retains the last successful inventory")
  assert.equal(stores.get("navigation")[0].selected, "finished", "a full outage preserves the originating selection")
  context.client.session.list = listSessions
  const listShells = context.client.shell.list
  context.client.shell.list = async () => { throw new Error("Location temporarily offline") }
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.doesNotMatch(test.captureCharFrame(), /Refresh failed|Refresh incomplete|Location temporarily offline/, "a successful inventory refresh clears the outage indicator even with a partial failure")
  assert.match(test.captureCharFrame(), /running/, "a partial refresh keeps the session table")
  context.client.shell.list = listShells
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  test.mockInput.pressEnter()
  await flush()
  assert.equal(route.type, "session", "Enter attaches")
  assert.equal(route.sessionID, "finished")
  test.mockInput.pressArrow("up")
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "finished latest prompt", "Up recalls only the attached chat's prompts")
  test.mockInput.pressArrow("up")
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "finished earlier prompt")
  test.renderer.currentFocusedEditor.gotoBufferEnd()
  test.mockInput.pressArrow("down")
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "finished latest prompt")
  test.mockInput.pressArrow("down")
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "", "Down restores the unsent draft")
  await test.mockInput.typeText("draft")
  test.mockInput.pressArrow("left")
  await flush()
  assert.equal(route.type, "session", "Left edits a draft without detaching")
  assert.equal(test.renderer.currentFocusedEditor.cursorOffset, 4)
  test.renderer.currentFocusedEditor.setText(" \t\n  ")
  test.mockInput.pressArrow("left")
  await flush()
  assert.equal(route.type, "plugin", "Left on whitespace-only prompt detaches")
  assert.equal(interruptions, 0, "detaching does not interrupt execution")
  await test.mockInput.typeText("fix the login tests")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "fix the login tests", JSON.stringify(stores.get("navigation")[0]))
  test.mockInput.pressEnter()
  await flush()
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].text, "fix the login tests")
  assert.equal(route.type, "plugin", "dispatch stays on the board")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "")
  test.mockInput.pressKey(" ")
  await flush()
  assert.equal(stores.get("navigation")[0].peek, true)
  assert.doesNotMatch(test.captureCharFrame(), /Reply to selected agent/)
  assert.match(test.captureCharFrame(), /Recent output/)
  await test.mockInput.typeText("continue")
  await flush()
  const replyEditor = test.renderer.currentFocusedEditor
  const peekSession = stores.get("navigation")[0].selected
  for (const previous of ["plain prompt", "first line\nsecond line\n", "windows\r\nprompt", "tab\tindent", "a wrapped prompt ".repeat(100), "emoji 👋 prompt"]) {
    for (const shifted of [true, false]) {
      replyEditor.setText("")
      await flush()
      recalledPrompts = [previous]
      test.mockInput.pressArrow("up", { shift: true })
      await flush()
      assert.equal(replyEditor.plainText, previous.replaceAll("\r\n", "\n"), "Shift+Up recalls the previous prompt from an empty reply")
      test.mockInput.pressArrow("down", { shift: shifted })
      await flush()
      assert.equal(replyEditor.plainText, "", `Down (shift=${shifted}) restores the empty peek reply after recalling ${JSON.stringify(previous)}`)
      assert.equal(stores.get("navigation")[0].selected, peekSession, "restoring an empty reply does not change the peeked session")
    }
  }
  recalledPrompts = undefined
  replyEditor.setText("continue")
  await flush()
  test.mockInput.pressArrow("up", { shift: true })
  await flush()
  assert.equal(replyEditor.plainText, `${peekSession} latest prompt`, "Shift+Up prefills the most recent user prompt")
  assert.equal(stores.get("navigation")[0].replies[peekSession], replyEditor.plainText, "recalled prompts sync to the reply draft")
  test.mockInput.pressArrow("up", { shift: true })
  await flush()
  assert.equal(replyEditor.plainText, `${peekSession} earlier prompt`, "Shift+Up recalls older prompts")
  test.mockInput.pressArrow("down", { shift: true })
  await flush()
  assert.equal(replyEditor.plainText, `${peekSession} latest prompt`, "Shift+Down recalls newer prompts")
  test.mockInput.pressArrow("down", { shift: true })
  await flush()
  assert.equal(test.renderer.currentFocusedEditor, replyEditor, "prompt recall keeps reply focus")
  assert.equal(replyEditor.plainText, "continue", "Shift+Down past newest restores the original draft")
  assert.equal(stores.get("navigation")[0].selected, peekSession, "prompt recall does not change sessions")
  test.mockInput.pressArrow("down")
  await flush()
  assert.equal(replyEditor.plainText, "continue", "Down on the latest unsent draft leaves it intact")
  test.mockInput.pressArrow("up")
  await flush()
  assert.equal(replyEditor.plainText, `${peekSession} latest prompt`, "plain Up recalls history once the reply contains text")
  test.mockInput.pressArrow("up")
  await flush()
  assert.equal(replyEditor.plainText, `${peekSession} earlier prompt`, "plain Up continues through older prompts")
  test.mockInput.pressArrow("down")
  await flush()
  assert.equal(replyEditor.plainText, `${peekSession} latest prompt`, "plain Down recalls newer prompts")
  test.mockInput.pressArrow("down")
  await flush()
  assert.equal(replyEditor.plainText, "continue", "plain Down past newest restores the unsent reply")
  assert.equal(stores.get("navigation")[0].selected, peekSession, "plain history navigation never switches sessions while replying")
  await test.mockInput.typeText("\nunfinished reply")
  test.mockInput.pressArrow("up")
  await flush()
  assert.equal(replyEditor.plainText, `${peekSession} latest prompt`, "plain Up uses the live typed reply before its content callback flushes")
  test.mockInput.pressArrow("down")
  await flush()
  assert.equal(replyEditor.plainText, "continue\nunfinished reply", "history preserves the complete multiline draft")
  for (const original of ["", "unsent reply"]) {
    replyEditor.setText(original)
    await flush()
    recalledPrompts = [`${peekSession} latest prompt`, "/review", "use @test-skill"]
    test.mockInput.pressArrow("up", { shift: true })
    await flush()
    assert.equal(replyEditor.plainText, recalledPrompts[0], "history starts at the newest prompt")
    for (const expected of recalledPrompts.slice(1)) {
      test.mockInput.pressArrow("up")
      await flush()
      assert.equal(replyEditor.plainText, expected, "plain Up traverses past recalled commands and skill mentions")
      assert.equal(test.renderer.root.findDescendantById("agents-view-completions"), undefined, "recall does not open autocomplete over history controls")
    }
    for (const expected of [recalledPrompts[1], recalledPrompts[0], original]) {
      test.mockInput.pressArrow("down")
      await flush()
      assert.equal(replyEditor.plainText, expected, "plain Down returns through commands and skills to the newest prompt and original draft")
    }
    assert.equal(stores.get("navigation")[0].selected, peekSession, "returning to the draft keeps the peek session selected")
  }
  test.mockInput.pressArrow("up", { shift: true })
  await flush()
  test.mockInput.pressArrow("up")
  await flush()
  assert.equal(replyEditor.plainText, "/review")
  test.mockInput.pressKey("BACKSPACE")
  await flush()
  assert.equal(replyEditor.plainText, "/revie")
  assert.ok(test.renderer.root.findDescendantById("agents-view-completions"), "editing a recalled command re-enables autocomplete")
  recalledPrompts = undefined
  replyEditor.setText("continue")
  await flush()
  test.mockInput.pressEnter()
  await flush()
  assert.equal(prompts.length, 2)
  assert.equal(prompts[1].sessionID, prompts[0].sessionID, "peek replies to the same session")
  assert.equal(route.type, "plugin", "nonempty peek replies stay on the board")
  for (const value of ["", " \t\n  "]) {
    test.renderer.currentFocusedEditor.setText(value)
    test.mockInput.pressEnter()
    await flush()
    assert.equal(route.type, "session", "Enter on an empty or whitespace-only peek reply attaches")
    assert.equal(route.sessionID, peekSession, "empty peek Enter attaches to the peeked chat")
    assert.equal(prompts.length, 2, "empty peek Enter does not send a prompt")
    test.mockInput.pressArrow("left")
    await flush()
    assert.equal(route.type, "plugin")
    assert.equal(stores.get("navigation")[0].peek, true)
  }
  test.renderer.currentFocusedEditor.setText("")
  await flush()
  test.mockInput.pressEscape()
  await flush()
  assert.equal(stores.get("navigation")[0].peek, false)
  assert.doesNotMatch(test.captureCharFrame(), /Reply to selected agent/)
  test.mockInput.pressEscape()
  await flush()
  assert.equal(route.type, "session", "Escape returns to originating session")
  test.mockInput.pressArrow("left")
  await flush()
  await test.mockInput.typeText("n:finished")
  test.mockInput.pressEnter()
  await flush()
  assert.equal(route.type, "session", "fast filter typing attaches instead of dispatching")
  assert.equal(route.sessionID, "finished")
  assert.equal(prompts.length, 2)
  await stores.get("preferences")[1]((draft) => { draft.hidden.push("finished") })
  test.mockInput.pressArrow("left")
  await flush()
  assert.equal(stores.get("preferences")[0].hidden.includes("finished"), false, "detaching restores a hidden originating row")
  assert.equal(stores.get("navigation")[0].selected, "finished")
  test.mockInput.pressEscape()
  await flush()
  sessions.push(session("archived-inactive", {
    location: { directory: "/inactive" }, outcome: "succeeded",
    time: { created: 1, updated: 2, archived: 3 },
  }), session("archived-launch-alias", {
    location: { directory: "/project/" }, outcome: "succeeded",
    time: { created: 1, updated: 2, archived: 3 },
  }))
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  let folderChoices
  assert.equal(test.renderer.root.findDescendantById("new-session-posix:/inactive"), undefined, "archived-only folder has no heading")
  context.ui.dialog.select = async (dialog) => { folderChoices = dialog.options; return "/inactive" }
  await test.mockInput.typeText("continue this task")
  test.mockInput.pressKey("n", { ctrl: true })
  await flush()
  assert.ok(test.renderer.root.findDescendantById("new-session-posix:/inactive"), "choosing an archived-only folder immediately adds its heading")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "continue this task", "folder selection preserves the focused draft")
  await test.mockInput.typeText(" in the chosen directory")
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.equal(stores.get("navigation")[0].draft, "continue this task in the chosen directory", "typing continues after the chooser closes")
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/inactive")
  assert.ok(test.renderer.root.findDescendantById("new-session-posix:/inactive"), "refresh keeps the empty task destination visible")
  test.mockInput.pressEscape()
  await flush()
  assert.equal(test.renderer.root.findDescendantById("new-session-posix:/inactive"), undefined, "cancelling the task hides its unused destination")
  folderChoices = undefined
  await test.mockInput.typeText("cycle visible folders only")
  for (const direction of ["down", "up"]) {
    test.mockInput.pressArrow(direction)
    await flush()
    assert.equal(stores.get("navigation")[0].selectedDirectory, "/project", "cycling skips archived-only folders")
  }
  test.mockInput.pressEscape()
  await flush()
  sessions.push(session("visible-inactive", { location: { directory: "/inactive" } }), session("archived-invisible", {
    location: { directory: "/invisible" }, time: { created: 1, updated: 2, archived: 3 },
  }))
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  await clickText("▾ /inactive")
  assert.match(test.captureCharFrame(), /preferred · \/project/, "highlighting a folder shows the new-session model, not the retained session cursor's model")
  context.ui.dialog.select = async () => undefined
  test.mockInput.pressKey("g", { ctrl: true })
  await flush()
  assert.deepEqual(modelLocations.at(-1), { directory: "/inactive" }, "Ctrl+G uses the highlighted folder before composing")
  assert.equal(route.type, "plugin", "model shortcut keeps the dashboard open")
  test.mockInput.pressKey("TAB")
  await flush()
  assert.deepEqual(agentLocations.at(-1), { directory: "/inactive" }, "agent picker uses the highlighted folder before composing")
  await test.mockInput.typeText("use this folder")
  test.mockInput.pressKey("g", { ctrl: true })
  await flush()
  assert.deepEqual(modelLocations.at(-1), { directory: "/inactive" }, "fast typing then opening the model picker retains the highlighted folder")
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/inactive", "typing inherits the highlighted folder instead of the selected session's repo")
  await test.mockInput.typeText(" for the task")
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/inactive", "continued typing keeps the target")
  test.mockInput.pressEscape()
  await flush()
  await clickText("▸ /inactive")
  await test.mockInput.typeText("cycle from highlighted folder")
  test.mockInput.pressArrow("down")
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/project", "fast typing then cycling starts from the highlighted folder")
  test.mockInput.pressEscape()
  await flush()
  context.ui.dialog.select = async (dialog) => { folderChoices = dialog.options; return "/inactive" }
  test.mockInput.pressKey("END")
  await flush()
  assert.ok(stores.get("navigation")[0].selected, "empty navigation only selects sessions")
  assert.equal(stores.get("navigation")[0].selectedDirectory, null)
  await test.mockInput.typeText("use selected session folder")
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory,
    sessions.find((item) => item.id === stores.get("navigation")[0].selected).location.directory,
    "typing inherits the selected session's directory")
  test.mockInput.pressEscape()
  await flush()
  context.ui.dialog.select = async (dialog) => { folderChoices = dialog.options; return "/invisible" }
  test.mockInput.pressKey("n", { ctrl: true })
  await flush()
  assert.ok(folderChoices.some((option) => option.value === "/invisible"), "empty prompt opens the chooser including archived-only folders")
  assert.ok(test.renderer.root.findDescendantById("new-session-posix:/invisible"), "empty selection reveals an archived-only destination")
  assert.match(test.captureCharFrame(), /Type a task in \/invisible/, "empty selection displays the next task's folder")
  const switchesBeforeDefault = modelSwitches.length
  context.ui.dialog.select = async (dialog) => {
    assert.equal(dialog.title, "Dispatch model")
    return "acme/chosen"
  }
  await test.mockInput.typeText("/models")
  test.mockInput.pressEnter()
  await flush()
  assert.equal(modelSwitches.length, switchesBeforeDefault, "folder model selection does not change a chat")
  assert.deepEqual(stores.get("navigation")[0].model, { providerID: "acme", id: "chosen" }, "folder model selection sets the new-session default")
  assert.match(test.captureCharFrame(), /chosen · \/project/, "top status bar shows the default while a folder is selected")
  await test.mockInput.typeText("start in the chosen folder")
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/invisible", "typing inherits the folder chosen before composition")
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressKey("END")
  await flush()
  folderChoices = undefined
  context.ui.dialog.select = async (dialog) => { folderChoices = dialog.options; return "/inactive" }
  test.mockInput.pressKey("f", { ctrl: true })
  await flush()
  test.mockInput.pressKey("n", { ctrl: true })
  await flush()
  assert.equal(folderChoices, undefined, "filters are not dispatch prompts")
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressKey("HOME")
  await flush()
  const sessionCursor = stores.get("navigation")[0].selected
  await test.mockInput.typeText("work in the inactive folder")
  // No render between typing and cycling: use the live input buffer.
  test.mockInput.pressArrow("down")
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/inactive")
  test.mockInput.pressArrow("down")
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/project", "folder cycling wraps")
  test.mockInput.pressArrow("up")
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/inactive", "reverse cycling wraps")
  test.mockInput.pressKey("n", { ctrl: true })
  await flush()
  assert.ok(folderChoices.some((option) => option.value === "/inactive"), "folder chooser includes archived inactive directories")
  assert.equal(folderChoices.filter((option) => option.value.startsWith("/project")).length, 1, "chooser merges launch-folder aliases")
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/inactive")
  assert.equal(stores.get("navigation")[0].selected, sessionCursor, "folder cycling preserves the session cursor")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "work in the inactive folder", "cycling preserves the prompt")
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/inactive", "refresh does not replace the selected folder")
  context.ui.dialog.select = async () => "acme/chosen"
  test.mockInput.pressKey("m", { meta: true })
  await flush()
  assert.deepEqual(modelLocations.at(-1), { directory: "/inactive" }, "model picker uses the target repo")
  assert.deepEqual(stores.get("navigation")[0].model, { providerID: "acme", id: "chosen" })
  assert.match(test.captureCharFrame(), /chosen · \/project/, "choosing a dispatch model updates the header while composing")
  test.mockInput.pressEnter()
  await flush()
  assert.equal(prompts.length, 3)
  assert.equal(sessions.find((item) => item.id === prompts[2].sessionID).location.directory, "/inactive", "state-grouped dispatch targets the chosen inactive folder")
  assert.deepEqual(sessions.find((item) => item.id === prompts[2].sessionID).model, { providerID: "acme", id: "chosen" }, "dispatch uses the model picker selection")
  const frame = test.captureCharFrame()
  assert.equal(frame.split("\n").filter((line) => line.trim() === "▾ /project").length, 1, "launch and existing sessions share one folder header")
  assert.equal(frame.split("\n").filter((line) => line.trim() === "▾ /inactive").length, 1, "inactive folder becomes the same live folder layout")
  assert.doesNotMatch(frame, /New session ·/)
  const headings = frame.split("\n").map((line) => line.trim().replace(/^[▸▾] /, ""))
  assert.ok(headings.indexOf("/inactive") < headings.indexOf("/project"), "the most recently prompted folder moves to the top")
  test.mockInput.pressKey("HOME")
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, null, "sending restores session-only navigation")
  const modelTarget = stores.get("navigation")[0].selected
  context.ui.dialog.select = async (dialog) => {
    assert.equal(dialog.title, "Chat model")
    return "acme/chosen"
  }
  await test.mockInput.typeText("/models")
  test.mockInput.pressEnter()
  await flush()
  assert.deepEqual(modelSwitches.at(-1), { sessionID: modelTarget, model: { providerID: "acme", id: "chosen" } }, "/models updates the dashboard's selected chat")
  assert.deepEqual(modelLocations.at(-1), { directory: "/inactive" }, "chat model picker uses the selected chat's location")
  assert.equal(prompts.length, 3, "model selection does not send a prompt")
  assert.match(test.captureCharFrame(), /chosen · \/project/, "chat header reflects the saved model")
  test.mockInput.pressEnter()
  await flush()
  assert.equal(route.type, "session", "empty Enter attaches to the existing session")
  assert.equal(sessions.find((item) => item.id === route.sessionID).location.directory, "/inactive")
  assert.equal(prompts.length, 3, "attaching does not send a model prompt")
  test.mockInput.pressArrow("left")
  await flush()
  const beforeClear = stores.get("navigation")[0].selected
  await test.mockInput.typeText("cancel this task")
  test.mockInput.pressArrow("down")
  await flush()
  test.mockInput.pressEscape()
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, null, "clearing the task clears its folder selection")
  assert.equal(stores.get("navigation")[0].selected, beforeClear, "clearing restores the original session cursor")
  test.resize(40, 12)
  await flush()
  assert.match(test.captureCharFrame(), /Agents/, "narrow terminal renders")
  assert.match(test.captureCharFrame(), /Type a task/, "short terminal keeps dispatch visible")
  test.mockInput.pressKey("c", { ctrl: true })
  await flush()
  assert.deepEqual(dispatchedCommands, ["app.exit"], "Ctrl+C quits through OpenCode's native exit command")
  assert.equal(route.type, "plugin", "Ctrl+C does not return to the conversation")
  await test.mockInput.typeText("unsent draft")
  test.mockInput.pressKey("c", { ctrl: true })
  await flush()
  assert.deepEqual(dispatchedCommands, ["app.exit", "app.exit"], "Ctrl+C quits even with a draft")
  test.renderer.currentFocusedEditor.setText("")
  await flush()
  test.mockInput.pressKey(" ")
  await flush()
  assert.equal(stores.get("navigation")[0].peek, true, "quit regression exercises an open peek")
  test.mockInput.pressKey("c", { ctrl: true })
  await flush()
  assert.equal(dispatchedCommands.at(-1), "app.exit", "Ctrl+C in peek also quits")
  assert.equal(dispatchedCommands.length, 3)
  assert.equal(route.type, "plugin")
  assert.equal(toasts.filter((toast) => toast.variant === "error").length, 0, JSON.stringify(toasts))
  test.mockInput.pressEscape()
  await flush()
  sessions.push(...["neighbor-first", "neighbor-middle", "neighbor-last"].map((id, index) => session(id, {
    location: { directory: "/zz-neighbors" }, time: { created: 100 + index, updated: 100 + index },
  })))
  test.resize(100, 28)
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  await stores.get("navigation")[1]((draft) => { draft.selected = "neighbor-middle" })
  await flush()
  context.client.shell.list = async () => { throw new Error("Location temporarily offline") }
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.doesNotMatch(test.captureCharFrame(), /Refresh failed/, "partial failures remain quiet while testing hide navigation")
  const hideSelected = async () => {
    const selected = stores.get("navigation")[0].selected
    test.mockInput.pressKey("x", { ctrl: true })
    await flush()
    assert.equal(stores.get("navigation")[0].selected, selected, "first Ctrl+X keeps the selected row")
    assert.ok(test.captureCharFrame().split("\n").some((line) => line.includes(selected) && /Needs input\s+· ctrl\+x again to hide/.test(line)), "first Ctrl+X replaces the reply preview while preserving the session status")
    test.mockInput.pressKey("x", { ctrl: true })
    await flush()
    assert.ok(stores.get("preferences")[0].hidden.includes(selected), "second Ctrl+X hides the selected row")
    assert.doesNotMatch(test.captureCharFrame(), /ctrl\+x again to hide/, "hiding the row clears the confirmation hint")
  }
  await hideSelected()
  assert.equal(stores.get("navigation")[0].selected, "neighbor-last", "hiding a middle row selects its next neighbor")
  await hideSelected()
  assert.equal(stores.get("navigation")[0].selected, "neighbor-first", "hiding the last row selects its previous neighbor")
  context.client.shell.list = listShells
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.match(test.captureCharFrame(), /ctrl\+z undo hide/, "footer offers undo after hiding")
  await test.mockInput.typeText("a draft")
  test.mockInput.pressKey("z", { ctrl: true })
  await flush()
  assert.ok(stores.get("preferences")[0].hidden.includes("neighbor-last"), "text editing does not undo hidden sessions")
  test.renderer.currentFocusedEditor.setText("")
  await flush()
  test.mockInput.pressKey("z", { ctrl: true })
  await flush()
  assert.ok(!stores.get("preferences")[0].hidden.includes("neighbor-last"), "Ctrl+Z restores the last hidden session")
  assert.ok(stores.get("preferences")[0].hidden.includes("neighbor-middle"), "undo leaves older hidden sessions alone")
  assert.ok(test.renderer.root.findDescendantById("agent-neighbor-last"), "restored row is rendered again")
  assert.doesNotMatch(test.captureCharFrame(), /ctrl\+z undo hide/, "undo hint clears after restoring")
  setMounted(false)
  await flush()
  assert.equal(activeLayers, 0, "unmount disposes global and page bindings")
  assert.equal(mode(), "base", "unmount releases the agents input mode")
  context.ui.router.navigate({ type: "home" })
  setMounted(true)
  await flush()
  assert.equal(route.type, "home", "remount does not reapply default landing")
  test.mockInput.pressKey("g", { ctrl: true })
  await flush()
  assert.equal(route.type, "plugin", "global shortcut works after remount")
  // A fresh dashboard must target the launch folder even when another folder
  // sorts first and already has sessions in the loaded inventory.
  test.resize(100, 28)
  await flush()
  sessions.push(session("alphabetically-first", { location: { directory: "/aaa-other-project" } }))
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  setMounted(false)
  await flush()
  await stores.get("navigation")[1]((draft) => {
    draft.previous = { type: "home" }
    draft.selected = null
    draft.selectedDirectory = null
    draft.draft = ""
    draft.peek = false
  })
  setMounted(true)
  await flush()
  test.mockInput.pressEnter()
  await flush()
  assert.equal(route.type, "plugin", "startup selects a folder rather than attaching to a session")
  assert.match(test.captureCharFrame(), /▸ \/project/, "Enter toggles the launch folder, not the first folder")
  await test.mockInput.typeText("a task for the current folder")
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/project", "initial task targets the launch folder")
  for (let index = 0; index < "a task for the current folder".length; index++) {
    test.mockInput.pressKey("BACKSPACE")
    await flush()
  }
  assert.equal(test.renderer.currentFocusedEditor.plainText, "", "backspace clears the task")
  assert.equal(stores.get("navigation")[0].selected, null, "clearing a folder draft does not select the first agent")
  test.mockInput.pressEnter()
  await flush()
  assert.equal(route.type, "plugin", "clearing a folder draft keeps folder navigation active")
  assert.match(test.captureCharFrame(), /▾ \/project/, "Enter still toggles the original folder after backspacing")
  await test.mockInput.typeText("another task")
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/project", "typing again retains the original folder")
  test.mockInput.pressEscape()
  await flush()
  context.location.directory = "/aaa-other-project"
  for (let index = sessions.length - 1; index >= 0; index--) {
    if (sessions[index].location.directory.replace(/\/$/, "") === "/project") sessions.splice(index, 1)
  }
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.ok(test.renderer.root.findDescendantById("new-session-posix:/project"), "empty launch folder remains rendered after the host location changes")
  for (const agent of ["plan", ""]) {
    context.ui.dialog.select = async (options) => {
      assert.equal(options.options[0].title, "Build (default)", "agent picker names the resolved default")
      assert.equal(options.options[0].value, "", "default selection still defers to OpenCode")
      return agent
    }
    test.mockInput.pressKey("TAB")
    await flush()
    assert.equal(stores.get("navigation")[0].agent, agent || null, "Tab stores the explicit agent, including configured default")
    context.ui.router.navigate({ type: "session", sessionID: "alphabetically-first" })
    await flush()
    test.mockInput.pressArrow("left")
    await flush()
    await test.mockInput.typeText("verify explicit dispatch agent")
    await flush()
    assert.match(test.captureCharFrame(), agent ? /^\s*Plan · ctrl\+x/m : /^\s*Build · ctrl\+x/m, "composer shows the explicit or resolved default agent after a session visit")
    test.mockInput.pressEnter()
    await flush()
    assert.equal(sessions.find((item) => item.id === prompts.at(-1).sessionID).agent, agent || undefined, "dispatch honors the retained agent selection")
  }
  const listAgentResponse = context.client.agent.list
  const [folderDefault, setFolderDefault] = createSignal("plan")
  const resolvedAgents = (location) => {
    const agents = cachedAgents(location).map((agent) => ({ ...agent, mode: "primary",
      model: { providerID: "acme", id: `${agent.id}-default` } }))
    const id = location.directory === "/aaa-other-project" ? folderDefault() : "build"
    return [...agents.filter((agent) => agent.id === id), ...agents.filter((agent) => agent.id !== id)]
  }
  context.data.location.agent.list = resolvedAgents
  context.client.agent.list = async ({ location }) => ({ data: resolvedAgents(location) })
  const savedDispatchModel = stores.get("navigation")[0].model
  const savedDispatchDirectory = stores.get("navigation")[0].selectedDirectory
  await stores.get("navigation")[1]((draft) => {
    draft.selectedDirectory = "/aaa-other-project"
    draft.model = null
  })
  await test.mockInput.typeText("inspect the folder default")
  await flush()
  assert.match(test.captureCharFrame(), /^\s*Plan · ctrl\+x/m, "composer resolves a non-Build default from the target folder's server ordering")
  assert.match(test.captureCharFrame(), /plan-default ·/, "default agent also supplies its configured model")
  context.ui.dialog.select = async (options) => {
    assert.equal(options.options[0].title, "Plan (default)", "picker resolves the target folder's default")
    return ""
  }
  test.mockInput.pressKey("TAB")
  await flush()
  assert.equal(stores.get("navigation")[0].agent, null, "displaying the resolved default does not pin its ID")
  setFolderDefault("build")
  await flush()
  assert.match(test.captureCharFrame(), /^\s*Build · ctrl\+x/m, "composer reacts when OpenCode's resolved default changes")
  setFolderDefault("plan")
  await stores.get("navigation")[1]((draft) => { draft.selectedDirectory = "/project" })
  await flush()
  assert.match(test.captureCharFrame(), /^\s*Build · ctrl\+x/m, "changing task folders resolves that folder's default")
  test.mockInput.pressEscape()
  await flush()
  context.data.location.agent.list = cachedAgents
  context.client.agent.list = listAgentResponse
  await stores.get("navigation")[1]((draft) => {
    draft.model = savedDispatchModel
    draft.selectedDirectory = savedDispatchDirectory
  })
  const beforeCommands = sessions.length
  await test.mockInput.typeText("/re")
  await flush()
  assert.match(test.captureCharFrame(), /\/release · Release changes/, "slash suggestions show command descriptions")
  assert.match(test.captureCharFrame(), /\/review · Review in/, "server commands appear in autocomplete")
  assertFooterAtBottom("command autocomplete")
  const completionFolder = stores.get("navigation")[0].selectedDirectory
  test.mockInput.pressArrow("down")
  test.mockInput.pressArrow("down")
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, completionFolder, "autocomplete navigation does not cycle task folders")
  test.mockInput.pressKey("TAB")
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "/review ", "Tab completes the selected command instead of opening the agent picker")
  assert.equal(sessions.length, beforeCommands, "completion does not start a session")
  await test.mockInput.typeText("staged changes")
  test.mockInput.pressEnter()
  await flush()
  assert.equal(commands.at(-1).name, "review")
  assert.equal(commands.at(-1).text, "staged changes", "command arguments reach the server")

  await test.mockInput.typeText("/test-conf")
  test.mockInput.pressEnter()
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "/test-config ", "fast Enter completes a reachable terminal command alias")
  const beforeLocal = sessions.length
  test.mockInput.pressEnter()
  await flush()
  assert.equal(dispatchedCommands.at(-1), "test.settings", "local commands use the native keymap instead of the server command API")
  assert.equal(sessions.length, beforeLocal, "terminal commands do not create sessions")

  await test.mockInput.typeText("/rev")
  context.ui.dialog.select = async () => "/inactive"
  test.mockInput.pressKey("n", { ctrl: true })
  await flush()
  assert.match(test.captureCharFrame(), /\/review · Review in \/inactive/, "changing the target folder changes command suggestions without losing the draft")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "/rev")
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressEscape()
  await flush()

  await test.mockInput.typeText("@test")
  await flush()
  assert.match(test.captureCharFrame(), /@test-skill · Test skill instructions/)
  test.resize(40, 12)
  await flush()
  assert.ok(test.renderer.currentFocusedEditor.y + test.renderer.currentFocusedEditor.height < 12, "completion keeps the input visible in short terminals")
  test.mockInput.pressEscape()
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "@test", "Escape dismisses autocomplete without clearing the draft")
  assert.equal(test.renderer.root.findDescendantById("agents-view-completions"), undefined)
  test.mockInput.pressEscape()
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "", "the next Escape clears the draft")
  test.resize(100, 28)
  await test.mockInput.typeText("Use @test")
  test.mockInput.pressKey("TAB")
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "Use @test-skill ", "skills complete inline before a render")
  test.mockInput.pressEnter()
  await flush()
  assert.deepEqual(prompts.at(-1).skills, [{ id: "test-skill", mention: { start: 4, end: 15, text: "@test-skill" } }], "dispatch attaches selected skills with mention offsets")
  const skillSession = prompts.at(-1).sessionID
  test.mockInput.pressKey(" ")
  await flush()
  await test.mockInput.typeText("@test")
  test.mockInput.pressArrow("up")
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "@test", "autocomplete keeps priority over plain-arrow reply history")
  assert.equal(stores.get("navigation")[0].selected, skillSession)
  test.mockInput.pressEnter()
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "@test-skill ", "Enter completes a skill in peek")
  test.mockInput.pressEnter()
  await flush()
  assert.equal(prompts.at(-1).sessionID, skillSession, "peek skills target the existing conversation")
  assert.equal(prompts.at(-1).skills[0].id, "test-skill")
  test.mockInput.pressEscape()
  await flush()
  assert.ok(completionLocations.includes(completionFolder), "completion synchronizes the target folder's catalog")
  assert.equal(toasts.filter((toast) => toast.variant === "error").length, 0, JSON.stringify(toasts))

  sessions.push(...["batch-first", "batch-middle", "batch-last"].map((id, index) => session(id, {
    location: { directory: "/zz-selection" }, time: { created: 100 + index, updated: 100 + index },
  })))
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  await stores.get("navigation")[1]((draft) => { draft.selected = "batch-first" })
  await flush()
  const highlightedRows = () => test.captureCharFrame().split("\n")
    .filter((line) => /✓ batch-/.test(line)).map((line) => /✓ (batch-\w+)/.exec(line)[1])
  const rowPoint = (id) => {
    const row = test.renderer.root.findDescendantById(`agent-${id}`)
    assert.ok(row, `drag target exists: ${id}`)
    return { x: row.x + 6, y: row.y }
  }
  const dragRows = async (from, to, modifiers = {}) => {
    const start = rowPoint(from)
    const end = rowPoint(to)
    await test.mockMouse.drag(start.x, start.y, end.x, end.y, 0, { modifiers })
    await flush()
  }
  if (!process.argv.includes("--folder-selection-only")) {
  test.resize(100, 50)
  await flush()
  await dragRows("batch-first", "batch-last")
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-middle", "batch-last"], "mouse drag highlights the origin, intermediate rows and destination")
  assert.equal(route.type, "plugin", "releasing a drag never opens either the captured chat or the drop target")
  assert.equal(stores.get("navigation")[0].selected, "batch-last", "dragging moves the chat cursor to the destination")
  assert.equal(test.renderer.currentFocusedEditor.id, "agents-view-input", "drag selection retains prompt focus")
  const firstPoint = rowPoint("batch-first")
  const lastPoint = rowPoint("batch-last")
  const middlePoint = rowPoint("batch-middle")
  await test.mockMouse.pressDown(firstPoint.x, firstPoint.y)
  await test.mockMouse.moveTo(lastPoint.x, lastPoint.y)
  await flush()
  await test.mockMouse.moveTo(middlePoint.x, middlePoint.y)
  await test.mockMouse.release(middlePoint.x, middlePoint.y)
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-middle"], "reversing a mouse drag shrinks its range rather than painting every visited chat")
  await dragRows("batch-last", "batch-middle")
  assert.deepEqual(highlightedRows(), ["batch-middle", "batch-last"], "an upward plain drag replaces the previous range")
  for (const modifier of ["shift", "ctrl"]) {
    const first = rowPoint("batch-first")
    const last = rowPoint("batch-last")
    await test.mockMouse.drag(first.x, first.y, first.x + 2, first.y)
    await flush()
    assert.deepEqual(highlightedRows(), ["batch-first"], "a horizontal drag can select just one chat")
    await test.mockMouse.drag(last.x, last.y, last.x + 2, last.y, 0, { modifiers: { [modifier]: true } })
    await flush()
    assert.deepEqual(highlightedRows(), ["batch-first", "batch-last"], `${modifier}+drag adds to the existing selection`)
  }
  test.mockInput.pressArrow("left", { shift: true })
  await flush()
  const heading = test.renderer.root.findDescendantById("new-session-posix:/zz-selection")
  const headingPoint = { x: heading.x + 3, y: heading.y }
  const first = rowPoint("batch-first")
  await test.mockMouse.drag(first.x, first.y, headingPoint.x, headingPoint.y)
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first"], "releasing over a folder keeps the nearest chat selected")
  assert.ok(!stores.get("preferences")[0].collapsedDirectories.includes("posix:/zz-selection"), "a drag release never collapses its drop folder")
  test.mockInput.pressArrow("left", { shift: true })
  await flush()
  await test.mockMouse.click(first.x, first.y)
  await flush()
  assert.equal(route.type, "session", "a fresh normal click after dragging still opens a chat")
  test.mockInput.pressArrow("left")
  await flush()
  await test.mockInput.typeText("keep this new task")
  await dragRows("batch-first", "batch-last")
  assert.deepEqual(highlightedRows(), [], "dragging while composing a new task does not convert it into a batch reply")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "keep this new task", "disabled drag selection preserves the task draft")
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressKey("HOME")
  await flush()
  // Return to a batch row before peeking, so both endpoints remain visible.
  await stores.get("navigation")[1]((draft) => { draft.selected = "batch-first" })
  await flush()
  test.mockInput.pressKey(" ")
  await flush()
  await test.mockInput.typeText("keep this peek reply")
  await dragRows("batch-first", "batch-last")
  assert.deepEqual(highlightedRows(), [], "peek replies never acquire a mouse batch selection")
  assert.equal(route.type, "plugin", "a disabled peek drag does not accidentally attach on release")
  assert.equal(stores.get("navigation")[0].peek, true, "dragging leaves peek open")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "keep this peek reply", "disabled drag selection preserves the peek reply")
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressEscape()
  await flush()
  await test.mockInput.typeText("n:batch")
  await flush()
  await dragRows("batch-first", "batch-last")
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-middle", "batch-last"], "mouse drag supports filtered chat rows")
  test.mockInput.pressArrow("left", { shift: true })
  await stores.get("preferences")[1]((draft) => { draft.pinned.push("batch-middle") })
  await flush()
  await dragRows("batch-middle", "batch-last")
  assert.deepEqual(highlightedRows(), ["batch-middle", "batch-first", "batch-last"], "drag ranges span the Pinned section, folder headings and gaps")
  test.mockInput.pressArrow("left", { shift: true })
  await stores.get("preferences")[1]((draft) => { draft.pinned = draft.pinned.filter((id) => id !== "batch-middle"); draft.hidden.push("batch-middle") })
  await flush()
  await dragRows("batch-first", "batch-last")
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-last"], "dragging skips hidden chats rather than selecting the underlying inventory")
  test.mockInput.pressArrow("left", { shift: true })
  await stores.get("preferences")[1]((draft) => { draft.hidden = draft.hidden.filter((id) => id !== "batch-middle") })
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressKey("s", { ctrl: true })
  await flush()
  await dragRows("batch-first", "batch-last")
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-middle", "batch-last"], "mouse selection also works in status grouping")
  test.mockInput.pressArrow("left", { shift: true })
  test.mockInput.pressKey("s", { ctrl: true })
  await stores.get("navigation")[1]((draft) => { draft.selected = "batch-first" })
  test.resize(100, 28)
  await flush()
  const orderBeforeHighlight = JSON.stringify(stores.get("preferences")[0].order ?? null)
  test.mockInput.pressArrow("down", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-middle"], "Shift+Down highlights the focused and next session")
  assert.equal(stores.get("navigation")[0].selected, "batch-middle", "Shift+Down moves the cursor")
  assert.equal(JSON.stringify(stores.get("preferences")[0].order ?? null), orderBeforeHighlight, "Shift+Down does not reorder")
  test.mockInput.pressArrow("left", { shift: true })
  await stores.get("navigation")[1]((draft) => { draft.selected = "batch-first" })
  await flush()
  test.mockInput.pressArrow("down", { ctrl: true, shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), [], "Ctrl+Shift+Down reorders without highlighting")
  assert.deepEqual(stores.get("preferences")[0].order.sessions["directory:posix:/zz-selection"], ["batch-middle", "batch-first", "batch-last"], "Ctrl+Shift+Down moves the focused session")
  assert.equal(stores.get("navigation")[0].selected, "batch-first", "reordering retains the focused session")
  test.mockInput.pressArrow("up", { ctrl: true, shift: true })
  await flush()
  test.mockInput.pressArrow("down", { shift: true })
  test.mockInput.pressArrow("down", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-middle", "batch-last"], "Shift+Down can highlight a whole folder")
  const chatOrder = stores.get("preferences")[0].order.sessions["directory:posix:/zz-selection"]
  test.mockInput.pressArrow("up", { ctrl: true, shift: true })
  await flush()
  const raised = stores.get("preferences")[0].order.folders?.indexOf("directory:posix:/zz-selection")
  test.mockInput.pressArrow("down", { ctrl: true, shift: true })
  await flush()
  assert.equal(stores.get("preferences")[0].order.folders.indexOf("directory:posix:/zz-selection"), raised + 1, "Ctrl+Shift+Up/Down moves a fully highlighted folder from a chat row")
  assert.deepEqual(stores.get("preferences")[0].order.sessions["directory:posix:/zz-selection"], chatOrder, "moving a whole folder keeps its chat order")
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-middle", "batch-last"], "moving a whole folder keeps it highlighted")
  test.mockInput.pressArrow("left", { shift: true })
  await stores.get("navigation")[1]((draft) => { draft.selected = "batch-first" })
  await flush()
  await stores.get("preferences")[1]((draft) => { delete draft.order })
  test.resize(100, 60)
  await flush()
  test.mockInput.pressArrow("right", { shift: true })
  test.mockInput.pressArrow("down")
  test.mockInput.pressArrow("right", { shift: true })
  test.mockInput.pressArrow("down")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-middle", "batch-last"], "Shift+Right selects rows while plain arrows navigate")
  assert.match(test.captureCharFrame(), /› ✓ batch-last/, "the active cursor remains distinguishable from other highlighted rows")
  test.mockInput.pressArrow("up")
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-middle", "batch-last"], "navigation retains highlighted sessions")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-last"], "Shift+Right toggles just the current session")
  test.mockInput.pressArrow("down")
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-last"], "plain arrows preserve non-neighbouring highlights")
  assert.match(test.captureCharFrame(), /› ✓ batch-last/, "plain arrows move the cursor without changing the batch")
  assert.equal(route.type, "plugin", "Shift+Right never attaches")
  const exitsBeforeSelection = dispatchedCommands.length
  test.mockInput.pressKey("c", { ctrl: true })
  await flush()
  assert.deepEqual(highlightedRows(), [], "Ctrl+C deselects all highlighted rows")
  assert.equal(dispatchedCommands.length, exitsBeforeSelection, "deselecting does not quit")
  test.mockInput.pressArrow("right", { shift: true })
  test.mockInput.pressArrow("up")
  test.mockInput.pressArrow("up")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-last"], "Shift+Right builds a discontiguous selection without a render between keys")
  const beforeBatchPrompts = prompts.length
  const beforeBatchSessions = sessions.length
  test.mockInput.pressEnter()
  await flush()
  assert.equal(route.type, "plugin", "empty Enter with highlighted chats does not attach or open a folder")
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-last"])
  assert.equal(prompts.length, beforeBatchPrompts, "empty Enter does not send to highlighted chats")
  await test.mockInput.typeText("continue both chats")
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-last"], "typing a batch prompt keeps highlighted chats")
  assert.match(test.captureCharFrame(), /› ✓ batch-first/, "batch composition keeps the chat cursor instead of selecting a task folder")
  test.mockInput.pressEnter()
  await flush()
  assert.deepEqual(prompts.slice(beforeBatchPrompts).map(({ sessionID, text }) => ({ sessionID, text })), [
    { sessionID: "batch-last", text: "continue both chats" },
    { sessionID: "batch-first", text: "continue both chats" },
  ], "Enter sends the same prompt only to the selected non-neighbouring chats")
  assert.equal(sessions.length, beforeBatchSessions, "batch submission never creates a new chat")
  assert.equal(route.type, "plugin", "batch submission stays on the dashboard")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "", "successful batch submission clears the prompt")
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-last"], "successful batch submission retains recipients")
  await test.mockInput.typeText("fast batch prompt")
  test.mockInput.pressEnter()
  await flush()
  assert.equal(prompts.length, beforeBatchPrompts + 4, "fast typing and Enter sends once to each highlighted chat")
  assert.equal(prompts.at(-1).text, "fast batch prompt")
  const queuePrompt = context.client.session.prompt
  context.client.session.prompt = async (input) => {
    if (input.sessionID === "batch-first") throw new Error("Batch recipient unavailable")
    await queuePrompt(input)
  }
  await test.mockInput.typeText("retry failed recipients")
  test.mockInput.pressEnter()
  await flush()
  context.client.session.prompt = queuePrompt
  assert.deepEqual(highlightedRows(), ["batch-first"], "partial failure selects only the failed chat for retry")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "retry failed recipients", "partial failure keeps the batch draft")
  assert.equal(prompts.at(-1).sessionID, "batch-last", "a failed recipient does not block other sends")
  const beforeRetry = prompts.length
  test.mockInput.pressEnter()
  await flush()
  assert.equal(prompts.length, beforeRetry + 1, "retry does not resend to successful recipients")
  assert.equal(prompts.at(-1).sessionID, "batch-first")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "")
  assert.deepEqual(test.captureCharFrame().split("\n").map((line) => /(batch-\w+)/.exec(line)?.[1]).filter(Boolean),
    ["batch-first", "batch-last", "batch-middle"], "sent prompts reorder the folder newest-prompt-first")
  test.mockInput.pressArrow("down")
  test.mockInput.pressArrow("right", { shift: true })
  test.mockInput.pressArrow("up")
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-last"])
  test.mockInput.pressKey("t", { ctrl: true })
  await flush()
  assert.ok(["batch-first", "batch-last"].every((id) => stores.get("preferences")[0].pinned.includes(id)), "Ctrl+T pins the selected batch")
  test.mockInput.pressKey("t", { ctrl: true })
  await flush()
  const beforeBatchStop = interruptions
  test.mockInput.pressKey("x", { ctrl: true })
  await flush()
  assert.equal(interruptions, beforeBatchStop + 2, "Ctrl+X stops all highlighted sessions and not the intervening row")
  assert.equal(test.captureCharFrame().split("\n").filter((line) => /batch-.*ctrl\+x again to hide/.test(line)).length, 2, "all batch targets show the hide confirmation")
  test.mockInput.pressKey("x", { ctrl: true })
  await flush()
  assert.ok(["batch-first", "batch-last"].every((id) => stores.get("preferences")[0].hidden.includes(id)), "second Ctrl+X hides the whole batch")
  assert.ok(!stores.get("preferences")[0].hidden.includes("batch-middle"), "batch hiding leaves unselected rows alone")
  assert.deepEqual(highlightedRows(), [], "hidden sessions are removed from the selection")
  test.mockInput.pressKey("z", { ctrl: true })
  await flush()
  assert.ok(["batch-first", "batch-last"].every((id) => !stores.get("preferences")[0].hidden.includes(id)), "Ctrl+Z restores the whole hidden batch")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  await test.mockInput.typeText("n:no-matching-batch")
  await flush()
  test.mockInput.pressKey("c", { ctrl: true })
  await flush()
  assert.equal(dispatchedCommands.length, exitsBeforeSelection, "Ctrl+C deselects filtered-out highlights without quitting")
  assert.doesNotMatch(test.captureCharFrame(), /1 selected/, "Ctrl+C clears the filtered-out selection")
  test.mockInput.pressEscape()
  await flush()
  await stores.get("navigation")[1]((draft) => { draft.selected = "batch-first" })
  await flush()
  test.mockInput.pressArrow("right", { shift: true })
  test.mockInput.pressKey(" ")
  await flush()
  assert.equal(stores.get("navigation")[0].peek, true)
  assert.deepEqual(highlightedRows(), [], "entering peek clears the batch selection")
  test.mockInput.pressArrow("up", { shift: true })
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "batch-first latest prompt", "Shift+Up still recalls prompts in peek")
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressArrow("right", { shift: true })
  test.mockInput.pressKey("s", { ctrl: true })
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first"], "grouping changes preserve highlights by session identity")
  test.mockInput.pressKey("s", { ctrl: true })
  await flush()
  test.mockInput.pressArrow("up")
  await flush()
  assert.match(test.captureCharFrame(), /› ▾ \/zz-selection.*1\/3 selected/, "moving to a folder keeps the multi-selection cursor visible")
  test.mockInput.pressKey(" ")
  await flush()
  assert.deepEqual(highlightedRows(), [], "collapsed chat rows are not individually rendered")
  assert.match(test.captureCharFrame(), /› ▸ \/zz-selection.*1\/3 selected/, "collapsed folder retains its cursor and partial selection")
  test.mockInput.pressKey(" ")
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first"], "unfolding restores the highlighted row")
  test.mockInput.pressArrow("left", { shift: true })
  await flush()
  const foldersBeforeMove = stores.get("preferences")[0].order?.folders
  test.mockInput.pressArrow("up", { ctrl: true, shift: true })
  await flush()
  assert.notDeepEqual(stores.get("preferences")[0].order.folders, foldersBeforeMove, "Ctrl+Shift+Up on a folder persists its order")
  assert.deepEqual(highlightedRows(), [], "moving a folder does not select its sessions")
  test.mockInput.pressArrow("down")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first"], "Shift+Right selects the first session after navigating from its folder")
  test.mockInput.pressEscape()
  await flush()
  assert.deepEqual(highlightedRows(), [], "Escape deselects all highlighted sessions")
  assert.equal(route.type, "plugin", "Escape deselection keeps the dashboard open")
  assert.equal(dispatchedCommands.length, exitsBeforeSelection, "Escape deselection never quits")
  await test.mockInput.typeText("n:batch")
  await flush()
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first"])
  test.mockInput.pressEscape()
  await flush()
  assert.deepEqual(highlightedRows(), [], "Escape deselects filtered sessions")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "n:batch", "Escape deselects before clearing the filter draft")
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressArrow("right", { shift: true })
  test.mockInput.pressKey("x", { ctrl: true })
  await flush()
  test.mockInput.pressKey("c", { ctrl: true })
  await flush()
  assert.doesNotMatch(test.captureCharFrame(), /ctrl\+x again to hide/, "Ctrl+C cancels pending batch hide confirmation")
  test.mockInput.pressKey("x", { ctrl: true })
  await flush()
  assert.ok(!stores.get("preferences")[0].hidden.includes("batch-first"), "Ctrl+X after deselecting stops again rather than unexpectedly hiding")
  test.mockInput.pressArrow("left", { shift: true })
  await flush()
  assert.equal(route.type, "plugin", "Shift+Left without highlights cancels confirmation without leaving")
  test.mockInput.pressArrow("right", { shift: true })
  await test.mockInput.typeText("a new task")
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first"], "composing with an explicitly highlighted chat retains it as a recipient")
  test.mockInput.pressArrow("left", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), [], "deselecting while typing returns to normal task composition")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "a new task", "deselecting preserves the prompt")
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressArrow("right", { shift: true })
  test.mockInput.pressArrow("down")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first", "batch-last"], "Down follows the newest-prompt-first order")
  test.mockInput.pressKey("x", { ctrl: true })
  await flush()
  const cursorBeforeDeselect = stores.get("navigation")[0].selected
  const commandsBeforeDeselect = dispatchedCommands.length
  test.mockInput.pressArrow("left", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), [], "Shift+Left deselects the entire batch")
  assert.doesNotMatch(test.captureCharFrame(), /ctrl\+x again to hide/, "Shift+Left cancels pending hide confirmation")
  for (const text of ["", "keep this task", "n:batch"]) {
    test.renderer.currentFocusedEditor.setText(text)
    await flush()
    test.renderer.currentFocusedEditor.gotoBufferEnd()
    const cursor = test.renderer.currentFocusedEditor.cursorOffset
    test.mockInput.pressArrow("left", { shift: true })
    await flush()
    assert.equal(route.type, "plugin", "Shift+Left with nothing highlighted never leaves the dashboard")
    assert.equal(test.renderer.currentFocusedEditor.plainText, text, "Shift+Left preserves the draft")
    assert.equal(test.renderer.currentFocusedEditor.cursorOffset, cursor, "Shift+Left never falls through to text selection")
    assert.equal(stores.get("navigation")[0].selected, cursorBeforeDeselect, "Shift+Left preserves the session cursor")
  }
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressKey(" ")
  await flush()
  assert.equal(stores.get("navigation")[0].peek, true)
  await test.mockInput.typeText("keep this reply")
  await flush()
  const replyCursorBeforeDeselect = test.renderer.currentFocusedEditor.cursorOffset
  test.mockInput.pressArrow("left", { shift: true })
  await flush()
  assert.equal(stores.get("navigation")[0].peek, true, "Shift+Left does not close peek")
  assert.equal(test.renderer.currentFocusedEditor.plainText, "keep this reply", "Shift+Left preserves peek replies")
  assert.equal(test.renderer.currentFocusedEditor.cursorOffset, replyCursorBeforeDeselect, "Shift+Left never moves the peek reply cursor")
  assert.equal(dispatchedCommands.length, commandsBeforeDeselect, "Shift+Left never dispatches an exit command")
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressEscape()
  await flush()
  }
  test.resize(100, 80)
  sessions.push(session("folder-outsider", { location: { directory: "/folder-other" } }),
    session("folder-hidden", { location: { directory: "/zz-selection" } }),
    session("folder-archived", { location: { directory: "/zz-selection" }, time: { created: 1, updated: 2, archived: 3 } }),
    session("folder-empty-history", { location: { directory: "/folder-empty" }, time: { created: 1, updated: 2, archived: 3 } }))
  const pinnedFolderChat = sessions.findIndex((item) => item.id === "batch-middle")
  sessions[pinnedFolderChat] = { ...sessions[pinnedFolderChat], location: { directory: "/zz-selection/" } }
  await stores.get("preferences")[1]((draft) => {
    draft.pinned.push("batch-middle")
    draft.hidden.push("folder-hidden")
  })
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  const hoverFolderHeading = async (directory) => {
    const item = test.renderer.root.findDescendantById(`new-session-posix:${directory}`)
    assert.ok(item, `folder selection target exists: ${directory}`)
    await test.mockMouse.moveTo(item.x + 3, item.y)
    await flush()
  }
  const hoverChat = async (id) => {
    const point = rowPoint(id)
    await test.mockMouse.moveTo(point.x, point.y)
    await flush()
  }
  const batchIDs = ["batch-first", "batch-last", "batch-middle"]
  await hoverChat("folder-outsider")
  test.mockInput.pressArrow("right", { shift: true })
  await hoverFolderHeading("/zz-selection")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows().sort(), batchIDs, "Shift+Right on a folder selects all its chats, including Pinned")
  assert.match(test.captureCharFrame(), /✓ folder-outsider/, "selecting a folder preserves other selections")
  assert.match(test.captureCharFrame(), /▾ \/zz-selection · ✓ 3\/3 selected/, "fully selected folder displays a checkmark and count")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), [], "toggling a selected folder deselects all its chats")
  assert.match(test.captureCharFrame(), /✓ folder-outsider/, "deselecting a folder leaves other folders alone")
  await hoverChat("batch-first")
  test.mockInput.pressArrow("right", { shift: true })
  await hoverFolderHeading("/zz-selection")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows().sort(), batchIDs, "selecting a partially selected folder fills its selection instead of inverting each chat")
  test.mockInput.pressArrow("left", { shift: true })
  test.mockInput.pressKey(" ")
  await flush()
  assert.match(test.captureCharFrame(), /▸ \/zz-selection/, "folder selection can begin with a collapsed folder")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.match(test.captureCharFrame(), /▸ \/zz-selection.*✓ 3\/3 selected/, "collapsed folder can select its hidden rows without unfolding")
  assert.equal(test.renderer.root.findDescendantById("agent-batch-first"), undefined, "folder selection does not force expansion")
  const beforeFolderStop = interruptions
  test.mockInput.pressKey("x", { ctrl: true })
  await flush()
  assert.equal(interruptions, beforeFolderStop + 3, "folder batch operations include folded and pinned chats, but not hidden, archived or other-folder chats")
  assert.match(test.captureCharFrame(), /▸ \/zz-selection.*ctrl\+x again to hide/, "collapsed folder shows the pending hide confirmation")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.deepEqual(highlightedRows(), [], "a collapsed folder selection can be toggled off")
  assert.doesNotMatch(test.captureCharFrame(), /3\/3 selected|ctrl\+x again to hide/, "folder deselection clears its count and confirmation")
  test.mockInput.pressArrow("right", { shift: true })
  test.mockInput.pressKey("x", { ctrl: true })
  await flush()
  test.mockInput.pressKey("x", { ctrl: true })
  await flush()
  assert.ok(batchIDs.every((id) => stores.get("preferences")[0].hidden.includes(id)), "a whole folder selection can be hidden as one batch")
  assert.ok(!stores.get("preferences")[0].hidden.includes("folder-outsider"), "folder hiding does not affect other folders")
  test.mockInput.pressKey("z", { ctrl: true })
  await flush()
  assert.ok(batchIDs.every((id) => !stores.get("preferences")[0].hidden.includes(id)), "undo restores the entire folder batch")
  await hoverFolderHeading("/zz-selection")
  test.mockInput.pressArrow("right", { shift: true })
  test.mockInput.pressKey(" ")
  await flush()
  assert.deepEqual(highlightedRows().sort(), batchIDs, "expanding a selected folder preserves and reveals its selected chats")
  await test.mockInput.typeText("n:batch-first")
  await flush()
  assert.deepEqual(highlightedRows(), ["batch-first"], "only matching selected rows are rendered")
  assert.match(test.captureCharFrame(), /3 selected/, "filtering retains the full folder selection")
  test.renderer.currentFocusedEditor.setText("n:no-matching-batch")
  await flush()
  assert.deepEqual(highlightedRows(), [], "a search can hide every selected row")
  assert.match(test.captureCharFrame(), /3 selected/, "a search with no matches retains every selection")
  test.mockInput.pressKey("t", { ctrl: true })
  await flush()
  assert.ok(batchIDs.every((id) => stores.get("preferences")[0].pinned.includes(id)), "batch actions include selected sessions filtered out of view")
  test.renderer.currentFocusedEditor.setText("n:folder-outsider")
  await flush()
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.match(test.captureCharFrame(), /4 selected/, "selecting another search result adds to the retained selection")
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.match(test.captureCharFrame(), /3 selected/, "toggling a search result off leaves filtered-out selections intact")
  test.renderer.currentFocusedEditor.setText("")
  await flush()
  assert.deepEqual(highlightedRows().sort(), batchIDs, "clearing search reveals all previously selected sessions")
  test.mockInput.pressKey("t", { ctrl: true })
  await flush()
  await stores.get("preferences")[1]((draft) => { draft.pinned.push("batch-middle") })
  test.renderer.currentFocusedEditor.setText("n:no-matching-batch")
  await flush()
  test.mockInput.pressEscape()
  await flush()
  assert.doesNotMatch(test.captureCharFrame(), /3 selected/, "Escape explicitly clears selections even when all are filtered out")
  test.mockInput.pressEscape()
  await flush()
  assert.deepEqual(highlightedRows(), [], "clearing search after deselecting does not restore selections")
  context.ui.dialog.select = async () => "/folder-empty"
  test.mockInput.pressKey("n", { ctrl: true })
  await flush()
  test.mockInput.pressArrow("right", { shift: true })
  await flush()
  assert.match(test.captureCharFrame(), /Type a task in \/folder-empty/, "selecting an empty folder leaves it as a task destination")
  assert.doesNotMatch(test.captureCharFrame(), /\/folder-empty.*selected/, "selecting an empty folder is a no-op")
  console.log("Folder selection passed: expanded/collapsed folders, pinned chats, partial selection, independent toggles, batch stop/hide/undo, deselection, empty folders")
  await hoverChat("folder-outsider")
  test.resize(100, 28)
  await flush()
  if (process.argv.includes("--readme-preview")) {
    // Feed representative data through the compiled UI, including older idle
    // rows ahead of working rows in the inventory to verify real sorting.
    const now = Date.now()
    const sample = (id, title, directory, minutes, outcome) => session(id, {
      title, location: { directory }, outcome,
      time: { created: now - minutes * 60_000 - 1000, updated: now },
    })
    sessions.splice(0, sessions.length,
      sample("preview-docs", "update documentation", "/project", 65, "succeeded"),
      sample("preview-login", "fix login tests", "/project", 3),
      sample("preview-permission", "review migration", "/projects/api", 12),
      sample("preview-timeout", "investigate timeout", "/projects/api", 5),
      sample("preview-server", "development server", "/projects/web", 20, "succeeded"),
      sample("preview-layout", "polish mobile layout", "/projects/web", 2),
    )
    context.client.session.active = async () => Object.fromEntries(
      ["preview-login", "preview-timeout", "preview-layout"].map((id) => [id, { type: "running" }]),
    )
    context.client.debug.location.list = async () => ["/project", "/projects/api", "/projects/web"].map((directory) => ({ directory }))
    context.client.permission.request.list = async ({ location }) => ({ data: location.directory === "/projects/api" ? [
      { id: "preview-permission-request", sessionID: "preview-permission", action: "edit", resources: ["src/migration.ts"] },
    ] : [] })
    context.client.shell.list = async ({ location }) => ({ data: location.directory === "/projects/web" ? [
      { id: "preview-shell", status: "running", command: "npm run dev", metadata: { sessionID: "preview-server" } },
    ] : [] })
    const summaries = {
      "preview-docs": "Updated the getting-started guide",
      "preview-login": "Running the test suite",
      "preview-timeout": "Reading the connection pool",
      "preview-layout": "Adjusting responsive breakpoints",
    }
    context.client.message.list = async ({ sessionID }) => ({ data: [{
      id: `message-${sessionID}`, type: "assistant", time: { created: now },
      content: [{ type: "text", text: summaries[sessionID] ?? "" }],
    }], cursor: {} })
    await stores.get("navigation")[1]((draft) => {
      draft.selected = "preview-login"
      draft.selectedDirectory = null
      draft.draft = ""
      draft.peek = false
      draft.model = null
      draft.modelInitialized = true
    })
    test.resize(120, 26)
    test.mockInput.pressKey("l", { ctrl: true })
    await flush()
    const frame = test.captureCharFrame()
    for (const directory of ["/project", "/projects/api", "/projects/web"]) assert.ok(frame.includes(`▾ ${directory}`))
    for (const [working, other] of [["fix login tests", "update documentation"], ["investigate timeout", "review migration"], ["polish mobile layout", "development server"]]) {
      assert.ok(frame.includes(working) && frame.includes(other) && frame.indexOf(working) < frame.indexOf(other), "working sessions lead each rendered folder")
    }
    assert.match(frame, /1 awaiting input · 3 working · 1 background shell · 1 done/)
    await stores.get("preferences")[1]((draft) => { draft.collapsedDirectories = ["posix:/projects/api"] })
    await stores.get("navigation")[1]((draft) => { draft.agent = "build" })
    await test.mockInput.typeText("Review the authentication changes in this project.")
    test.mockInput.pressKey("j", { ctrl: true })
    await test.mockInput.typeText("Add regression coverage for the login flow.")
    await flush()
    const preview = test.captureCharFrame()
    assert.match(preview, /▸ \/projects\/api · 1 needs input · 1 working/)
    assert.match(preview, /Review the authentication changes/)
    assert.match(preview, /Add regression coverage/)
    console.log("--- README TUI preview ---")
    console.log(preview.split("\n").map((line) => line.trimEnd()).join("\n"))
    console.log("--- End README TUI preview ---")
  }
  if (!process.argv.includes("--folder-selection-only")) console.log("Native terminal smoke passed: folder-first layout, navigation, dispatch, peek/reply, filtering, inactive folders, blank sessions, resize, command/skill autocomplete, multi-selection, batch stop/hide/undo, Ctrl+C deselect/quit")
} finally {
  if (typeof cleanup === "function") cleanup()
  test.renderer.destroy()
  unregisterMode()
  sources.dispose()
}
