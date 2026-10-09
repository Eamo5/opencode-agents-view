import assert from "node:assert/strict"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createComponent, createElement, insert, render, setProp } from "@opentui/solid"
import { createComputed, createMemo, createSignal, onCleanup, onMount } from "solid-js"
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
const modelLocations = []
const dispatchedCommands = []
const color = RGBA.fromHex("#abcdef")
const feedback = { warning: { base: color }, error: { base: color }, success: { base: color } }
const theme = { text: { base: color, muted: color, feedback }, background: { base: RGBA.fromHex("#000000"), raised: { base: color } }, hue: { accent: { 500: color } }, border: { base: color } }
const session = (id, overrides = {}) => ({
  id, title: id, projectID: "project", agent: "build", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: Date.now() - 10000, updated: Date.now() }, location: { directory: "/project" }, ...overrides,
})
const sessions = [session("running"), session("finished", { outcome: "succeeded" })]
let releaseInventory
const inventoryReady = new Promise((resolve) => { releaseInventory = resolve })
let recentOutput = "Recent output from the agent"
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
    model: { list: async ({ location }) => {
      modelLocations.push(location)
      return { data: [{ providerID: "acme", id: "chosen", name: "Chosen model" }] }
    } },
    location: { get: async () => ({ directory: "/project", project: { id: "project" } }) },
    session: {
      list: async () => { await inventoryReady; return { data: sessions, cursor: {} } }, active: async () => ({ running: { type: "running" } }),
      create: async (input) => { const value = session(`new-${sessions.length}`, input); sessions.push(value); return value },
      prompt: async (input) => { prompts.push(input) },
      interrupt: async () => { interruptions++; return { interrupted: true } },
    },
    message: { list: async () => ({ data: [{ id: "m", type: "assistant", time: { created: 1 }, content: [{ type: "text", text: recentOutput }] }], cursor: {} }) },
    permission: { request: { list: async () => ({ data: [] }) } }, form: { list: async () => ({ data: [] }) },
  },
  data: {
    listen: () => () => {}, location: { default: () => ({ directory: "/project" }) },
    session: { list: () => [], family: () => [], status: () => "idle", message: { list: () => [] }, permission: { list: () => [] }, form: { list: () => [] } },
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
    dispatch: (command) => { dispatchedCommands.push(command) },
    mode: { current: mode, push: (name) => {
      const id = Symbol()
      setModes((items) => [...items, { name, id }])
      return () => setModes((items) => items.filter((item) => item.id !== id))
    } },
    layer(factory) {
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
        onCleanup(dispose)
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
function Host() {
  createComputed(() => keymap.setData("mode", mode()))
  cleanup = plugin.setup(context)
  const box = createElement("box")
  setProp(box, "height", "100%")
  setProp(box, "width", "100%")
  insert(box, () => slots.filter((slot) => slot.append === "app").map((slot) => slot.render({})))
  insert(box, () => route.type === "plugin" ? pages.get(route.name).render({}) : createComponent(SessionPrompt, {}))
  return box
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 25))
  await test.flush()
}
try {
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
  assert.match(test.captureCharFrame(), /Working/)
  assert.equal(stores.get("preferences")[0].grouping, "directory", "folder-first default")
  assert.doesNotMatch(test.captureCharFrame(), /New session ·/, "no duplicated per-folder action rows")
  assert.match(test.captureCharFrame(), /Completed/)
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
  await test.mockInput.typeText("stash this unsent task")
  test.mockInput.pressKey("s", { ctrl: true, shift: true })
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "", "Ctrl+Shift+S stashes the live draft")
  assert.equal(stores.get("preferences")[0].grouping, "directory", "stash does not change grouping")
  test.mockInput.pressKey("s", { ctrl: true, meta: true })
  await flush()
  assert.equal(test.renderer.currentFocusedEditor.plainText, "stash this unsent task", "Ctrl+Alt+S restores the draft")
  for (const grouping of ["state", "directory"]) {
    test.mockInput.pressKey("s", { ctrl: true })
    await flush()
    assert.equal(stores.get("preferences")[0].grouping, grouping, "Ctrl+S arranges the agents panel")
    assert.equal(test.renderer.currentFocusedEditor.plainText, "stash this unsent task", "grouping preserves the draft")
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
  assert.match(test.captureCharFrame(), /▸ \/project/)
  assert.doesNotMatch(test.captureCharFrame(), /running/, "clicking a folder hides its sessions")
  test.mockInput.pressEnter()
  await flush()
  assert.match(test.captureCharFrame(), /running/, "Enter expands the selected folder")
  test.mockInput.pressKey("HOME")
  test.mockInput.pressArrow("up")
  test.mockInput.pressEnter()
  await flush()
  assert.doesNotMatch(test.captureCharFrame(), /running/, "keyboard reaches and collapses the heading")
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
  test.mockInput.pressKey("l", { ctrl: true })
  await flush()
  assert.match(test.captureCharFrame(), /live progress/, "working summaries update without an inventory timestamp change")
  test.mockInput.pressEnter()
  await flush()
  assert.equal(route.type, "session", "Enter attaches")
  assert.equal(route.sessionID, "finished")
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
  assert.match(test.captureCharFrame(), /Reply to selected agent/)
  assert.match(test.captureCharFrame(), /Recent output/)
  await test.mockInput.typeText("continue")
  test.mockInput.pressEnter()
  await flush()
  assert.equal(prompts.length, 2)
  assert.equal(prompts[1].sessionID, prompts[0].sessionID, "peek replies to the same session")
  test.mockInput.pressEscape()
  await flush()
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
  await clickText("▾ /inactive")
  await test.mockInput.typeText("use this folder")
  await flush()
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
  assert.equal(stores.get("navigation")[0].selectedDirectory, "/project", "typing inherits the selected session's directory")
  test.mockInput.pressEscape()
  await flush()
  test.mockInput.pressKey("n", { ctrl: true })
  await flush()
  assert.equal(folderChoices, undefined, "empty prompt cannot open the folder chooser")
  test.mockInput.pressKey("f", { ctrl: true })
  await flush()
  test.mockInput.pressKey("n", { ctrl: true })
  await flush()
  assert.equal(folderChoices, undefined, "filters are not dispatch prompts")
  test.mockInput.pressEscape()
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
  assert.ok(headings.indexOf("/inactive") < headings.indexOf("/project"), "launch folder stays in alphabetical order")
  test.mockInput.pressKey("HOME")
  await flush()
  assert.equal(stores.get("navigation")[0].selectedDirectory, null, "sending restores session-only navigation")
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
  console.log("Native terminal smoke passed: folder-first layout, navigation, dispatch, peek/reply, filtering, inactive folders, blank sessions, resize, Ctrl+C native quit")
} finally {
  if (typeof cleanup === "function") cleanup()
  test.renderer.destroy()
  unregisterMode()
  sources.dispose()
}
