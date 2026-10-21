import { afterEach, describe, expect, it, vi } from "vitest"
import { createController, type Controller } from "../src/controller.ts"
import { parseOptions } from "../src/options.ts"
import { fixture, session } from "./fixture.ts"

let controller: Controller | undefined
afterEach(() => { controller?.dispose(); controller = undefined; vi.useRealTimers() })
function setup(initial = [session("root")], options = {}) {
  const f = fixture(initial)
  controller = createController(f.context, parseOptions(options))
  return { ...f, c: controller }
}

describe("agents view lifecycle", () => {
  it.each([{ providerID: "acme", id: "chosen" }, null])("preserves an explicit new-session model default across navigation: %s", async (model) => {
    const f = setup()
    f.c.updateMemory((memory) => {
      memory.model = model
      memory.modelSelected = true
      memory.modelInitialized = true
    })
    vi.spyOn(f.context.ui.model, "current").mockReturnValue({ providerID: "other", modelID: "chat-model" })
    f.setRoute({ type: "session", sessionID: "root" })
    await f.c.open()
    await f.c.dispatch("new task")
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ model: model ?? undefined }), expect.anything())
    expect(f.c.memory.model).toEqual(model)
  })
  it("loads only the latest user prompt for every root, including collapsed folders, and caches unchanged inventory", async () => {
    const first = session("first", { time: { created: 1000, updated: 9000 } })
    const second = session("second", { time: { created: 2000, updated: 3000 }, location: { directory: "/other" } })
    const f = setup([first, second, session("child", { parentID: "first" }), session("archived", { time: { created: 1, updated: 2, archived: 3 } })])
    await f.c.toggleDirectory("/other")
    const messages = vi.mocked(f.context.client.message.list).mockImplementation(async ({ sessionID }) => ({
      data: [{ id: sessionID, type: "user", time: { created: sessionID === "first" ? 4000 : 5000 }, text: "Prompt" }], cursor: {},
    }))
    await f.c.refresh()
    expect(messages).toHaveBeenCalledTimes(2)
    expect(messages).toHaveBeenCalledWith({ sessionID: "second", type: "user", order: "desc", limit: 1 }, expect.anything())
    expect(f.c.groups().map((group) => group.directory)).toEqual(["/other", "/project"])
    expect(f.c.rows().find((row) => row.session.id === "first")?.lastPromptAt).toBe(4000)
    await f.c.refresh()
    expect(messages).toHaveBeenCalledTimes(2)
    first.time.updated++
    await f.c.refresh()
    expect(messages).toHaveBeenCalledTimes(3)
  })
  it("sorts from cached user prompts without letting assistant or synthetic messages change recency", async () => {
    const f = setup([session("first"), session("second")])
    vi.spyOn(f.context.data.session.message, "list").mockImplementation((id) => [
      { id: `${id}-prompt`, type: "user", time: { created: id === "first" ? 4000 : 3000 }, text: "Prompt" },
      { id: `${id}-output`, type: "synthetic", time: { created: 8000 }, text: "Background update" },
      { id: `${id}-assistant`, type: "assistant", agent: "build", model: { providerID: "acme", id: "model" }, time: { created: 9000 }, content: [] },
    ])
    await f.c.refresh()
    expect(f.c.groups()[0].rows.map((row) => row.session.id)).toEqual(["first", "second"])
    expect(f.c.rows().find((row) => row.session.id === "first")?.lastPromptAt).toBe(4000)
  })
  it("moves a pinned chat to the top immediately when a user prompt is queued elsewhere", async () => {
    const f = setup([session("first"), session("second")])
    await f.c.refresh()
    await f.c.togglePin(["first", "second"])
    f.emit({ type: "session.inbox.enqueued", created: 5000, data: { sessionID: "second", item: { type: "user" } } } as Parameters<typeof f.emit>[0])
    expect(f.c.groups()[0].rows.map((row) => row.session.id)).toEqual(["second", "first"])
    f.emit({ type: "session.inbox.enqueued", created: 6000, data: { sessionID: "first", item: { type: "synthetic" } } } as Parameters<typeof f.emit>[0])
    expect(f.c.groups()[0].rows.map((row) => row.session.id)).toEqual(["second", "first"])
  })
  it("updates recency on successful dashboard sends but not failures or /stop", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(5000)
    const f = setup([session("first"), session("second")])
    await f.c.refresh()
    expect(await f.c.reply("second", "Continue")).toBe(true)
    expect(f.c.groups()[0].rows.map((row) => row.session.id)).toEqual(["second", "first"])
    f.prompt.mockRejectedValueOnce(new Error("offline"))
    expect(await f.c.reply("first", "Failed prompt")).toBe(false)
    expect(f.c.rows().find((row) => row.session.id === "first")?.lastPromptAt).toBe(1000)
    await f.c.reply("first", "/stop")
    expect(f.c.rows().find((row) => row.session.id === "first")?.lastPromptAt).toBe(1000)
    vi.setSystemTime(6000)
    await f.c.reply("first", "/review changes")
    expect(f.c.groups()[0].rows.map((row) => row.session.id)).toEqual(["first", "second"])
  })
  it("retains known prompt times on lookup failure and retries without failing the inventory", async () => {
    const current = session("root")
    const f = setup([current])
    const messages = vi.mocked(f.context.client.message.list).mockResolvedValue({ data: [
      { id: "prompt", type: "user", time: { created: 5000 }, text: "Prompt" },
    ], cursor: {} })
    await f.c.refresh()
    current.time.updated++
    messages.mockRejectedValueOnce(new Error("offline"))
    await f.c.refresh()
    expect(f.c.rows()[0].lastPromptAt).toBe(5000)
    expect(f.c.refreshFailed()).toBe(false)
    expect(f.notify).not.toHaveBeenCalled()
    await f.c.refresh()
    expect(messages).toHaveBeenCalledTimes(3)
  })
  it("discovers background shells in idle live locations and rolls subagent jobs into their root", async () => {
    const f = setup([
      session("root", { outcome: "succeeded", location: { directory: "/other" } }),
      session("child", { parentID: "root", location: { directory: "/other" } }),
      session("unrelated", { outcome: "succeeded" }),
      session("historical", { location: { directory: "/deleted" } }),
    ])
    vi.mocked(f.context.client.debug.location.list).mockResolvedValue([{ directory: "/other" }])
    const job = (id: string, sessionID?: string) => ({
      id, status: "running" as const, command: "npm run dev", cwd: "/other", shell: "zsh", file: "/output",
      metadata: { sessionID: sessionID ?? null }, time: { started: 1000 },
    })
    const shells = vi.mocked(f.context.client.shell.list).mockImplementation(async (input) => ({
      location: { directory: input?.location?.directory ?? "/project" }, data: input?.location?.directory === "/other" ? [job("one", "child"), job("two", "root"), job("unowned")] : [],
    }))
    await f.c.refresh()
    expect(f.c.error()).toBe("")
    expect(f.c.rows().find((row) => row.session.id === "root")).toMatchObject({
      state: "background-shell", summary: "2 running shells: npm run dev · npm run dev",
    })
    expect(f.c.rows().find((row) => row.session.id === "unrelated")?.state).toBe("completed")
    expect(shells.mock.calls.map(([input]) => input?.location?.directory)).toEqual(["/project", "/other"])

    // A failed refresh retains the last known running jobs; the next successful
    // snapshot clears them, even if a shell exit event was missed.
    shells.mockRejectedValueOnce(new Error("offline"))
    await f.c.refresh()
    expect(f.c.rows().find((row) => row.session.id === "root")?.state).toBe("background-shell")
    shells.mockResolvedValue({ location: { directory: "/other" }, data: [
      { ...job("one", "child"), status: "exited" }, { ...job("two", "root"), status: "killed" },
    ] })
    await f.c.refresh()
    expect(f.c.rows().find((row) => row.session.id === "root")?.state).toBe("completed")
  })
  it("refreshes shell state on creation, exit, and deletion events", async () => {
    vi.useFakeTimers()
    const f = setup()
    await f.c.refresh()
    for (const type of ["shell.created", "shell.exited", "shell.deleted"]) {
      f.list.mockClear()
      f.emit({ type, data: {} } as Parameters<typeof f.emit>[0])
      await vi.advanceTimersByTimeAsync(200)
      expect(f.list).toHaveBeenCalledOnce()
    }
  })
  it("does not refetch inventory for streamed tokens but refreshes on completion", async () => {
    vi.useFakeTimers()
    const f = setup()
    await f.c.refresh()
    f.list.mockClear()
    for (const type of ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta", "session.tool.progress", "session.step.streamed"]) {
      f.emit({ type, data: {} } as Parameters<typeof f.emit>[0])
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(f.list).not.toHaveBeenCalled()
    f.emit({ type: "session.execution.succeeded", data: {} } as Parameters<typeof f.emit>[0])
    await vi.advanceTimersByTimeAsync(200)
    expect(f.list).toHaveBeenCalledOnce()
  })
  it("resolves the selected directory without scanning every session's messages", async () => {
    const f = setup([session("first"), session("second", { location: { directory: "/other" } })])
    await f.c.refresh()
    f.c.select("second")
    const messages = vi.spyOn(f.context.data.session.message, "list")
    expect(f.c.dispatchLocation()).toEqual({ directory: "/other" })
    expect(messages).not.toHaveBeenCalled()
  })
  it("reuses a fresh peek preview but refreshes stale or changed output", async () => {
    vi.useFakeTimers()
    const f = setup()
    const row = session("root")
    const messages = vi.mocked(f.context.client.message.list)
    await f.c.loadPreview(row, true)
    await f.c.loadPreview(row, true)
    expect(messages).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 1001)
    await f.c.loadPreview(row, true)
    expect(messages).toHaveBeenCalledTimes(2)
    row.time.updated += 1
    await f.c.loadPreview(row, true)
    expect(messages).toHaveBeenCalledTimes(3)
  })
  it("does not carry an old session agent when opening from home", async () => {
    const f = setup()
    f.c.updateMemory((draft) => { draft.agent = "old-project-agent" })
    f.setRoute({ type: "home" })
    await f.c.open()
    expect(f.c.memory.agent).toBeNull()
  })
  it.each(["reviewer", null])("preserves an explicit dispatch agent %s across session visits and home", async (agent) => {
    const f = setup([session("root", { agent: "plan" })])
    await f.c.refresh()
    await f.c.open()
    f.c.setDispatchAgent(agent)
    f.c.attach("root")
    await f.c.open()
    expect(f.c.memory.agent).toBe(agent)
    expect(f.c.selectedSession()?.agent).toBe("plan")
    f.setRoute({ type: "home" })
    await f.c.open()
    expect(f.c.memory.agent).toBe(agent)
    await f.c.dispatch("new task")
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ agent: agent ?? undefined }), expect.anything())
  })
  it("never sends new work after plugin disposal", async () => {
    const f = setup()
    f.c.dispose()
    expect(await f.c.dispatch("late task")).toBe(false)
    expect(await f.c.reply("root", "late reply")).toBe(false)
    expect(f.create).not.toHaveBeenCalled()
    expect(f.prompt).not.toHaveBeenCalled()
  })
  it("preserves a newly chosen dispatch target while a session is being created", async () => {
    const f = setup()
    let finish!: (value: ReturnType<typeof session>) => void
    f.create.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    f.c.selectDirectory("/first")
    const task = f.c.dispatch("first task")
    f.c.selectDirectory("/next")
    f.c.updateMemory((draft) => { draft.draft = "next task" })
    finish(session("created", { location: { directory: "/first" } }))
    await task
    expect(f.c.dispatchLocation()).toEqual({ directory: "/next" })
    expect(f.c.memory.draft).toBe("next task")
  })
  it("inherits the prompt model when it loads after the agents view opens", async () => {
    const f = setup([])
    const current = vi.spyOn(f.context.ui.model, "current")
    await f.c.open()
    expect(f.c.memory.model).toBeNull()
    current.mockReturnValue({ providerID: "acme", modelID: "preferred", variant: "high" })
    await f.c.dispatch("start with the selected model")
    expect(f.create.mock.calls[0][0].model).toEqual({ providerID: "acme", id: "preferred", variant: "high" })
  })
  it("does not overwrite an explicit default-model choice during hydration", async () => {
    const f = setup([])
    await f.c.open()
    f.c.updateMemory((draft) => { draft.model = null; draft.modelInitialized = true })
    vi.spyOn(f.context.ui.model, "current").mockReturnValue({ providerID: "acme", modelID: "other" })
    f.c.syncInitialModel()
    await f.c.dispatch("use configured defaults")
    expect(f.create.mock.calls[0][0].model).toBeUndefined()
  })
  it("inherits the live prompt model and variant instead of stale session metadata", async () => {
    const f = setup([session("other", { location: { directory: "/other" }, model: { providerID: "acme", id: "old" } })])
    await f.c.refresh()
    f.setRoute({ type: "session", sessionID: "other" })
    vi.spyOn(f.context.ui.model, "current").mockReturnValue({ providerID: "acme", modelID: "new", variant: "high" })
    await f.c.open()
    expect(f.c.memory.model).toEqual({ providerID: "acme", id: "new", variant: "high" })
    await f.c.dispatch("use my selected model")
    expect(f.create.mock.calls[0][0]).toMatchObject({ location: { directory: "/other" }, model: { providerID: "acme", id: "new", variant: "high" } })
  })
  it("does not carry a different conversation's model into one using defaults", async () => {
    const f = setup([session("defaults")])
    await f.c.refresh()
    f.c.updateMemory((draft) => { draft.model = { providerID: "old", id: "unavailable" } })
    f.setRoute({ type: "session", sessionID: "defaults" })
    await f.c.open()
    expect(f.c.memory.model).toBeNull()
    await f.c.dispatch("use defaults")
    expect(f.create.mock.calls[0][0].model).toBeUndefined()
  })
  it("adopts folder-first grouping for older preferences and remembers an explicit toggle", async () => {
    const f = fixture()
    f.stores.set("preferences", { grouping: "state", pinned: ["root"], hidden: [], defaultToAgentsView: true })
    controller = createController(f.context, parseOptions({}))
    expect(controller.grouping()).toBe("directory")
    await controller.toggleGrouping()
    expect(controller.grouping()).toBe("state")
    expect(controller.preferences.pinned).toEqual(["root"])
    controller.dispose()
    controller = createController(f.context, parseOptions({}))
    expect(controller.grouping()).toBe("state")
  })
  it("persists collapsed folders across controller reloads using normalized directory identity", async () => {
    const f = fixture()
    f.stores.set("preferences", { grouping: "directory", pinned: ["root"], hidden: [], defaultToAgentsView: true })
    controller = createController(f.context, parseOptions({}))
    expect(controller.isCollapsed("C:/Work/Project")).toBe(false)
    await controller.toggleDirectory("C:/Work/Project")
    await controller.toggleDirectory("/Work")
    controller.dispose()
    controller = createController(f.context, parseOptions({}))
    expect(controller.isCollapsed("c:\\work\\project\\")).toBe(true)
    expect(controller.isCollapsed("/Work")).toBe(true)
    expect(controller.isCollapsed("/work")).toBe(false)
    await controller.toggleDirectory("c:\\work\\project")
    expect(controller.isCollapsed("C:/Work/Project")).toBe(false)
    expect(controller.isCollapsed("/Work")).toBe(true)
    expect(controller.preferences.pinned).toEqual(["root"])
  })
  it("detaches a running session without interrupting and Esc returns to the route snapshot", () => {
    const f = setup()
    f.setRoute({ type: "session", sessionID: "root" })
    f.c.open()
    expect(f.route()).toMatchObject({ type: "plugin", name: "agents-view" })
    expect(f.c.memory.selected).toBe("root")
    expect(f.interrupt).not.toHaveBeenCalled()
    f.c.attach("other")
    f.c.back()
    expect(f.route()).toEqual({ type: "session", sessionID: "root" })
  })
  it("dispatches an independent root session and keeps the table open", async () => {
    const f = setup()
    f.c.open()
    f.c.updateMemory((draft) => { draft.draft = "fix login"; draft.agent = "reviewer"; draft.model = { providerID: "acme", id: "model" } })
    expect(await f.c.dispatch("fix login")).toBe(true)
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ agent: "reviewer", model: { providerID: "acme", id: "model" }, location: { directory: "/project" } }), expect.anything())
    expect(f.create.mock.calls[0][0]).not.toHaveProperty("parentID")
    expect(f.prompt).toHaveBeenCalledWith({ sessionID: "created", text: "fix login", delivery: "queue" }, expect.anything())
    expect(f.route().type).toBe("plugin")
    expect(f.c.memory.draft).toBe("")
  })
  it("brings a hidden originating conversation back when detaching", async () => {
    const f = setup()
    await f.c.refresh()
    await f.c.stopOrHide("root", 1000)
    await f.c.stopOrHide("root", 2000)
    expect(f.c.rows()).toHaveLength(0)
    f.setRoute({ type: "session", sessionID: "root" })
    await f.c.open()
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["root"])
    expect(f.c.memory.selected).toBe("root")
    expect(f.c.memory.previous).toEqual({ type: "session", sessionID: "root" })
    expect(f.interrupt).toHaveBeenCalledOnce()
  })
  it("reloads live-root output on refresh even when inventory timestamps are unchanged", async () => {
    const f = setup([session("root"), session("child", { parentID: "root" }), session("finished", { outcome: "succeeded" })])
    vi.mocked(f.context.client.session.active).mockResolvedValue({ child: { type: "running" } })
    const messages = vi.mocked(f.context.client.message.list)
    messages.mockImplementation(async ({ sessionID }) => ({ data: [{
      id: sessionID, type: "user", time: { created: 1 }, text: "First output",
    }], cursor: {} }))
    await f.c.refresh()
    await f.c.loadPreviews(f.c.rows().map((row) => row.session))
    expect(f.c.rows().find((row) => row.session.id === "root")?.summary).toBe("First output")
    messages.mockImplementation(async ({ sessionID }) => ({ data: [{
      id: sessionID, type: "user", time: { created: 1 }, text: "New progress",
    }], cursor: {} }))
    await f.c.refresh()
    await f.c.loadPreviews(f.c.rows().map((row) => row.session))
    expect(f.c.rows().find((row) => row.session.id === "root")?.summary).toBe("New progress")
    expect(f.c.rows().find((row) => row.session.id === "finished")?.summary).toBe("First output")
    expect(messages.mock.calls.filter(([input]) => !input.type)).toHaveLength(3)
  })
  it("attaches only after successful prompt admission", async () => {
    const f = setup()
    await f.c.dispatch("fix login", true)
    expect(f.route()).toEqual({ type: "session", sessionID: "created" })
  })
  it("preserves a failed prompt draft and its recoverable session", async () => {
    const f = setup()
    f.prompt.mockRejectedValue(new Error("Disconnected"))
    f.c.updateMemory((draft) => { draft.draft = "keep me" })
    expect(await f.c.dispatch("keep me", true)).toBe(false)
    expect(f.c.memory.draft).toBe("keep me")
    expect(f.c.rows().some((row) => row.session.id === "created")).toBe(true)
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.route().type).toBe("home")
  })
  it("queues a peek reply without navigating or creating another session", async () => {
    const f = setup()
    f.c.updateMemory((draft) => { draft.replies.root = "continue" })
    await f.c.reply("root", "continue")
    expect(f.prompt).toHaveBeenCalledWith({ sessionID: "root", text: "continue", delivery: "queue" }, expect.anything())
    expect(f.create).not.toHaveBeenCalled()
    expect(f.navigate).not.toHaveBeenCalled()
    expect(f.c.memory.replies.root).toBeUndefined()
  })
  it("keeps edits made while prompt admission is in flight", async () => {
    const f = setup()
    f.c.updateMemory((draft) => { draft.draft = "first task" })
    f.prompt.mockImplementation(async () => { f.c.updateMemory((draft) => { draft.draft = "next task" }) })
    await f.c.dispatch("first task")
    expect(f.c.memory.draft).toBe("next task")
  })
  it("queues the same prompt to each unique selected chat without creating or navigating", async () => {
    const f = setup()
    f.c.updateMemory((draft) => { draft.draft = "continue"; draft.replies.root = "unsent peek reply" })
    expect(await f.c.replyMany(["root", "other", "root"], "continue")).toEqual({ sent: ["root", "other"], failed: [] })
    expect(f.prompt.mock.calls.map(([input]) => input)).toEqual([
      { sessionID: "root", text: "continue", delivery: "queue" },
      { sessionID: "other", text: "continue", delivery: "queue" },
    ])
    expect(f.create).not.toHaveBeenCalled()
    expect(f.navigate).not.toHaveBeenCalled()
    expect(f.c.memory.draft).toBe("")
    expect(f.c.memory.replies.root).toBe("unsent peek reply")
    expect(f.c.sending()).toBe(false)
  })
  it("settles all batch recipients and keeps the draft when some sends fail", async () => {
    const f = setup()
    f.c.updateMemory((draft) => { draft.draft = "continue" })
    f.prompt.mockRejectedValueOnce(new Error("Unavailable"))
    expect(await f.c.replyMany(["root", "other"], "continue")).toEqual({ sent: ["other"], failed: ["root"] })
    expect(f.prompt).toHaveBeenCalledTimes(2)
    expect(f.c.memory.draft).toBe("continue")
    expect(f.c.sending()).toBe(false)
    expect(await f.c.replyMany(["root"], "continue")).toEqual({ sent: ["root"], failed: [] })
    expect(f.c.memory.draft).toBe("")
  })
  it("ignores empty batches, blank prompts, and duplicate submissions while sending", async () => {
    const f = setup()
    await f.c.replyMany([], "continue")
    await f.c.replyMany(["root"], " \t\n")
    expect(f.prompt).not.toHaveBeenCalled()
    let release!: () => void
    f.prompt.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const pending = f.c.replyMany(["root", "other"], "continue")
    expect(f.c.sending()).toBe(true)
    await f.c.replyMany(["root", "other"], "continue")
    expect(f.prompt).toHaveBeenCalledTimes(2)
    release()
    await pending
  })
  it("preserves a batch draft edited while admission is in flight", async () => {
    const f = setup()
    f.c.updateMemory((draft) => { draft.draft = "first" })
    f.prompt.mockImplementation(async () => { f.c.updateMemory((draft) => { draft.draft = "next" }) })
    await f.c.replyMany(["root", "other"], "first")
    expect(f.c.memory.draft).toBe("next")
  })
  it("resolves batch command skills separately in each recipient's folder", async () => {
    const f = setup([session("root"), session("other", { location: { directory: "/other" } })])
    await f.c.refresh()
    vi.mocked(f.context.client.skill.list).mockResolvedValue({ location: { directory: "/project" }, data: [
      { id: "review", name: "Review", path: "/skills/review.md", content: "Review" },
    ] })
    await f.c.replyMany(["root", "other"], "/review use @review")
    expect(vi.mocked(f.context.client.skill.list).mock.calls.map(([input]) => input?.location?.directory).sort()).toEqual(["/other", "/project"])
    expect(f.command.mock.calls.map(([input]) => input)).toEqual(["root", "other"].map((sessionID) => ({
      sessionID, name: "review", text: "use @review", delivery: "queue",
      skills: [{ id: "review", mention: { start: 4, end: 11, text: "@review" } }],
    })))
    expect(f.prompt).not.toHaveBeenCalled()
  })
  it("interrupts every batch recipient for /stop", async () => {
    const f = setup()
    await f.c.replyMany(["root", "other"], "/stop")
    expect(vi.mocked(f.context.client.session.interrupt).mock.calls.map(([input]) => input.sessionID)).toEqual(["root", "other"])
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.command).not.toHaveBeenCalled()
  })
  it("switches the model of every selected chat", async () => {
    const f = setup()
    const switchModel = vi.fn().mockResolvedValue(undefined)
    Object.assign(f.context.client.session, { switchModel })
    const model = { providerID: "anthropic", id: "claude" }
    await f.c.setSessionModel(["root", "other"], model)
    expect(switchModel.mock.calls.map(([input]) => input)).toEqual([
      { sessionID: "root", model }, { sessionID: "other", model },
    ])
    expect(f.c.memory.model).toBeNull()
  })
  it.each([
    [{ providerID: "acme", modelID: "picked-in-chat" }, true],
    [{ providerID: "anthropic", modelID: "claude" }, false],
  ])("warns once on attach when the chat keeps a different model: %o", async (current, warns) => {
    vi.useFakeTimers()
    const f = setup()
    Object.assign(f.context.client.session, { switchModel: vi.fn().mockResolvedValue(undefined) })
    vi.spyOn(f.context.ui.model, "current").mockReturnValue(current)
    await f.c.setSessionModel(["root"], { providerID: "anthropic", id: "claude" })
    f.c.attach("root")
    vi.advanceTimersByTime(250)
    const warnings = () => f.notify.mock.calls.filter(([toast]) => toast.variant === "warning")
    expect(warnings()).toHaveLength(warns ? 1 : 0)
    if (warns) expect(warnings()[0][0].message).toContain("picked-in-chat")
    f.c.attach("root")
    vi.advanceTimersByTime(250)
    expect(warnings()).toHaveLength(warns ? 1 : 0)
  })
  it("dispatches slash commands through the command API", async () => {
    const f = setup()
    await f.c.dispatch("/review staged changes")
    expect(f.command).toHaveBeenCalledWith({ sessionID: "created", name: "review", text: "staged changes", delivery: "queue" }, expect.anything())
    expect(f.prompt).not.toHaveBeenCalled()
  })
  it("attaches explicitly mentioned skills to a new task in its target folder", async () => {
    const f = setup()
    const skill = { id: "review", name: "Review", path: "/skills/review.md", content: "Review" }
    vi.mocked(f.context.client.skill.list).mockResolvedValue({ location: { directory: "/other" }, data: [skill] })
    f.create.mockResolvedValue(session("created", { location: { directory: "/other" } }))
    f.c.selectDirectory("/other")
    expect(await f.c.dispatch("Use @review please")).toBe(true)
    expect(f.context.client.skill.list).toHaveBeenCalledWith({ location: { directory: "/other" } }, expect.anything())
    expect(f.prompt).toHaveBeenCalledWith({
      sessionID: "created", text: "Use @review please", delivery: "queue",
      skills: [{ id: "review", mention: { start: 4, end: 11, text: "@review" } }],
    }, expect.anything())
  })
  it("resolves reply skills in the recipient's folder with command-relative offsets", async () => {
    const f = setup([session("root", { location: { directory: "/recipient" } })])
    await f.c.refresh()
    f.c.selectDirectory("/elsewhere")
    vi.mocked(f.context.client.skill.list).mockResolvedValue({ location: { directory: "/recipient" }, data: [
      { id: "review", name: "Review", path: "/skills/review.md", content: "Review" },
    ] })
    expect(await f.c.reply("root", "/review use @review")).toBe(true)
    expect(f.context.client.skill.list).toHaveBeenCalledWith({ location: { directory: "/recipient" } }, expect.anything())
    expect(f.command).toHaveBeenCalledWith({
      sessionID: "root", name: "review", text: "use @review", delivery: "queue",
      skills: [{ id: "review", mention: { start: 4, end: 11, text: "@review" } }],
    }, expect.anything())
  })
  it("keeps skill reply drafts on lookup failure and leaves unknown mentions as text", async () => {
    const f = setup()
    f.c.updateMemory((draft) => { draft.replies.root = "Use @review" })
    vi.mocked(f.context.client.skill.list).mockRejectedValueOnce(new Error("Skills unavailable"))
    expect(await f.c.reply("root", "Use @review")).toBe(false)
    expect(f.c.memory.replies.root).toBe("Use @review")
    expect(f.prompt).not.toHaveBeenCalled()
    expect(await f.c.reply("root", "Use @unknown")).toBe(true)
    expect(f.prompt).toHaveBeenCalledWith({ sessionID: "root", text: "Use @unknown", delivery: "queue" }, expect.anything())
  })
  it("paginates and aggregates child permission requests into the root", async () => {
    const f = setup()
    f.list.mockReset().mockResolvedValueOnce({ data: [session("root")], cursor: { next: "next" } })
      .mockResolvedValueOnce({ data: [session("child", { parentID: "root" })], cursor: {} })
    vi.mocked(f.context.client.session.active).mockResolvedValue({ child: { type: "running" } })
    vi.mocked(f.context.client.permission.request.list).mockResolvedValue({ location: { directory: "/project" }, data: [{ id: "p", sessionID: "child", action: "edit", resources: ["file"] }] })
    await f.c.refresh()
    expect(f.c.rows()).toHaveLength(1)
    expect(f.c.rows()[0].state).toBe("needs-input")
    expect(f.c.rows()[0].summary).toContain("Permission: edit")
    expect(f.list.mock.calls[0][0]).toEqual({ limit: 100, order: "desc" })
    expect(f.list.mock.calls[1][0]).toEqual({ cursor: "next" })
  })
  it("filters by project identity, including worktrees", async () => {
    const f = setup([session("worktree", { location: { directory: "/trees/feature" } }), session("other", { projectID: "other" })], { scope: "project" })
    await f.c.refresh()
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["worktree"])
  })
  it("dispatches into the selected directory when grouped by directory", async () => {
    const f = setup([session("worktree", { location: { directory: "/trees/feature" } })])
    await f.c.refresh()
    expect(f.c.grouping()).toBe("directory")
    f.c.updateMemory((draft) => { draft.selected = "worktree" })
    await f.c.dispatch("review this worktree")
    expect(f.create.mock.calls[0][0].location).toEqual({ directory: "/trees/feature" })
  })
  it("uses the selected conversation's directory in state grouping too", async () => {
    const f = setup([session("inactive", { outcome: "succeeded", location: { directory: "/inactive" } })])
    await f.c.refresh()
    await f.c.toggleGrouping()
    f.c.select("inactive")
    await f.c.dispatch("start a new task here")
    expect(f.create.mock.calls[0][0].location).toEqual({ directory: "/inactive" })
  })
  it("retains validated archived and hidden folders as dispatch targets", async () => {
    const f = setup([session("old", { location: { directory: "/inactive" }, time: { created: 1, updated: 2, archived: 3 } })])
    await f.c.refresh()
    expect(f.c.rows()).toEqual([])
    expect(f.c.directories()).toEqual(["/inactive", "/project"])
    expect(f.c.groups().map((group) => group.directory)).toEqual(["/project"])
    f.c.selectDirectory("/inactive")
    expect(f.c.dispatchLocation()).toEqual({ directory: "/inactive" })
    expect(f.c.memory.selected).toBeNull()
    expect(f.context.client.location.get).toHaveBeenCalledTimes(2)
    await f.c.dispatch("restart work here")
    expect(f.create.mock.calls[0][0].location).toEqual({ directory: "/inactive" })
  })
  it("keeps an empty launch folder when the host location follows another session", async () => {
    const f = setup([session("elsewhere", { location: { directory: "/other" } })])
    await f.c.refresh()
    f.c.attach("elsewhere")
    Object.assign(f.context.location!, { directory: "/other" })
    await f.c.open()
    await f.c.refresh()
    expect(f.c.location().directory).toBe("/project")
    expect(f.c.directories()).toEqual(["/other", "/project"])
    expect(f.c.groups().find((group) => group.directory === "/project")?.rows).toEqual([])
    expect(f.c.groups("n:missing").map((group) => group.directory)).toEqual(["/project"])
    f.c.selectDirectory("/project")
    await f.c.dispatch("work in the original empty folder")
    expect(f.create.mock.calls[0][0].location).toEqual({ directory: "/project" })
  })
  it("opens a blank new root session in the selected inactive folder without submitting a prompt", async () => {
    const f = setup()
    f.c.selectDirectory("/inactive")
    expect(await f.c.newSession()).toBe(true)
    expect(f.create.mock.calls[0][0].location).toEqual({ directory: "/inactive" })
    expect(f.create.mock.calls[0][0]).not.toHaveProperty("parentID")
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.route()).toEqual({ type: "session", sessionID: "created" })
    expect(f.c.memory.selectedDirectory).toBeNull()
  })
  it("preserves the chosen folder and draft if new-session creation fails", async () => {
    const f = setup()
    f.c.selectDirectory("/inactive")
    f.c.updateMemory((draft) => { draft.draft = "keep this task" })
    f.create.mockRejectedValue(new Error("Directory no longer exists"))
    expect(await f.c.newSession()).toBe(false)
    expect(f.c.dispatchLocation()).toEqual({ directory: "/inactive" })
    expect(f.c.memory.draft).toBe("keep this task")
    expect(f.navigate).not.toHaveBeenCalled()
    expect(f.c.sending()).toBe(false)
  })
  it("clears session filters and peek when choosing a folder while preserving task drafts", () => {
    const f = setup()
    f.c.updateMemory((draft) => { draft.draft = "n:old-session"; draft.peek = true })
    f.c.selectDirectory("/inactive")
    expect(f.c.memory).toMatchObject({ draft: "", peek: false, selected: null, selectedDirectory: "/inactive" })
    f.c.updateMemory((draft) => { draft.draft = "a normal task" })
    f.c.selectDirectory("/project")
    expect(f.c.memory.draft).toBe("a normal task")
  })
  it("deduplicates the launch folder and live-folder requests by Windows identity", async () => {
    const base = fixture([session("root", { location: { directory: "c:\\work\\project\\" } })])
    Object.assign(base.context.location!, { directory: "C:/Work/Project" })
    controller = createController(base.context, parseOptions({}))
    const f = { ...base, c: controller }
    vi.mocked(f.context.client.session.active).mockResolvedValue({ root: { type: "running" } })
    await f.c.refresh()
    expect(f.c.directories()).toEqual(["C:/Work/Project"])
    expect(f.c.groups()).toHaveLength(1)
    expect(f.c.groups()[0].rows).toHaveLength(1)
    expect(f.context.client.permission.request.list).toHaveBeenCalledTimes(1)
  })
  it("does not offer unrelated projects' historical folders in project scope", async () => {
    const f = setup([session("worktree", { location: { directory: "/trees/feature" } }),
      session("other", { projectID: "other", location: { directory: "/other" } })], { scope: "project" })
    await f.c.refresh()
    expect(f.c.directories()).toEqual(["/project", "/trees/feature"])
  })
  it("shows pending forms as human input without treating them as permission decisions", async () => {
    const f = setup()
    vi.mocked(f.context.client.form.list).mockResolvedValue({
      location: { directory: "/project" },
      data: [{ id: "form", sessionID: "root", title: "Question", fields: [{ type: "string", key: "answer", title: "Which database?" }] }],
    })
    await f.c.refresh()
    expect(f.c.rows()[0]).toMatchObject({ state: "needs-input", summary: "Which database?" })
  })
  it("does not load inboxes for inactive historical locations", async () => {
    const f = setup([session("old-worktree", { location: { directory: "/deleted/worktree" }, outcome: "succeeded" })])
    await f.c.refresh()
    expect(f.context.client.permission.request.list).toHaveBeenCalledTimes(1)
    expect(f.context.client.permission.request.list).toHaveBeenCalledWith({ location: { directory: "/project" } }, expect.anything())
  })
  it("checks historical folders before showing sessions without requiring selection", async () => {
    const missing = session("missing", { location: { directory: "/deleted" } })
    const f = setup([session("root"), missing, session("sibling", { location: missing.location })])
    f.cached.push(missing)
    vi.mocked(f.context.client.location.get).mockImplementation(async (input) => {
      if (input?.location?.directory === "/deleted") throw {
        _tag: "LocationNotFoundError", location: missing.location, message: "Location not found",
      }
      return { directory: "/project", project: { id: "project" } } as Awaited<ReturnType<typeof f.context.client.location.get>>
    })
    expect(f.c.rows()).toEqual([])
    expect(f.c.directories()).toEqual(["/project"])
    await f.c.open()
    await f.c.refresh()
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["root"])
    expect(f.c.directories()).toEqual(["/project"])
    expect(f.c.error()).toBe("")
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.context.client.message.list).toHaveBeenCalledOnce()
    expect(f.context.client.message.list).toHaveBeenCalledWith(expect.objectContaining({ sessionID: "root", type: "user" }), expect.anything())
    expect(f.context.client.location.get).toHaveBeenCalledTimes(2)
    await f.c.refresh()
    expect(f.context.client.location.get).toHaveBeenCalledTimes(4)
  })
  it.each(["/project", "/restored"])("rediscovers a restored folder %s on refresh", async (directory) => {
    const f = setup([session("restored", { location: { directory } })])
    let missing = true
    vi.mocked(f.context.client.location.get).mockImplementation(async (input) => {
      if (missing && input?.location?.directory === directory) throw {
        _tag: "LocationNotFoundError", location: { directory }, message: "Location not found",
      }
      return { directory: input?.location?.directory, project: { id: "project" } } as Awaited<ReturnType<typeof f.context.client.location.get>>
    })
    await f.c.refresh()
    expect(f.c.rows()).toEqual([])
    expect(f.c.directories()).not.toContain(directory)
    missing = false
    await f.c.refresh()
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["restored"])
    expect(f.c.directories()).toContain(directory)
    expect(f.c.error()).toBe("")
  })
  it("keeps the last snapshot on network failure", async () => {
    const f = setup()
    await f.c.refresh()
    f.list.mockRejectedValue(new Error("Server offline"))
    await f.c.refresh()
    expect(f.c.rows()).toHaveLength(1)
    expect(f.c.error()).toBe("Server offline")
    expect(f.c.refreshFailed()).toBe(true)
    f.list.mockResolvedValue({ data: [session("root")], cursor: {} })
    vi.mocked(f.context.client.shell.list).mockRejectedValue(new Error("Shells unavailable"))
    await f.c.refresh()
    expect(f.c.error()).toContain("Shells unavailable")
    expect(f.c.refreshFailed()).toBe(false)
  })
  it("retains a failed folder's snapshot while committing healthy folders and fresh inventory", async () => {
    const initial = [session("healthy", { outcome: "succeeded" }), session("broken", { location: { directory: "/broken" }, outcome: "succeeded" })]
    const f = setup(initial)
    vi.mocked(f.context.client.debug.location.list).mockResolvedValue([{ directory: "/broken" }])
    const permissions = vi.mocked(f.context.client.permission.request.list).mockImplementation(async (input) => ({
      location: { directory: input?.location?.directory ?? "/project" }, data: [{ id: input?.location?.directory ?? "", sessionID: input?.location?.directory === "/broken" ? "broken" : "healthy", action: "edit", resources: ["file"] }],
    }))
    await f.c.refresh()
    expect(f.c.rows().map((row) => row.state)).toEqual(["needs-input", "needs-input"])
    permissions.mockImplementation(async (input) => ({ location: { directory: input?.location?.directory ?? "/project" }, data: [] }))
    const shells = vi.mocked(f.context.client.shell.list).mockImplementation(async (input) => {
      if (input?.location?.directory === "/broken") throw new Error("temporarily offline")
      return { location: { directory: input?.location?.directory ?? "/project" }, data: [] }
    })
    f.list.mockResolvedValue({ data: [...initial, session("new")], cursor: {} })
    await f.c.refresh()
    expect(f.c.rows().find((row) => row.session.id === "healthy")?.state).toBe("completed")
    expect(f.c.rows().find((row) => row.session.id === "broken")?.state).toBe("needs-input")
    expect(f.c.rows().some((row) => row.session.id === "new")).toBe(true)
    expect(f.c.error()).toContain("/broken: temporarily offline")
    expect(f.c.refreshFailed()).toBe(false)
    shells.mockImplementation(async (input) => ({ location: { directory: input?.location?.directory ?? "/project" }, data: [] }))
    await f.c.refresh()
    expect(f.c.rows().find((row) => row.session.id === "broken")?.state).toBe("completed")
    expect(f.c.error()).toBe("")
  })
  it("isolates historical validation failures and retries them before showing their sessions", async () => {
    const f = setup([session("root"), session("unverified", { location: { directory: "/unverified" } })])
    const get = vi.mocked(f.context.client.location.get)
    const healthy = await f.context.client.location.get({ location: { directory: "/project" } })
    get.mockImplementation(async (input) => {
      if (input?.location?.directory === "/unverified") throw new Error("validation unavailable")
      return healthy
    })
    await f.c.refresh()
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["root"])
    expect(f.c.error()).toContain("/unverified: validation unavailable")
    get.mockResolvedValue(healthy)
    await f.c.refresh()
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["root", "unverified"])
    expect(f.c.error()).toBe("")
  })
  it("retains project scope when launch-location metadata fails", async () => {
    const f = setup([session("root"), session("tree", { location: { directory: "/tree" } }), session("other", { projectID: "other" })], { scope: "project" })
    await f.c.refresh()
    vi.mocked(f.context.client.location.get).mockRejectedValue(new Error("metadata unavailable"))
    f.list.mockResolvedValue({ data: [session("root", { title: "updated" }), session("tree", { location: { directory: "/tree" } }), session("other", { projectID: "other" })], cursor: {} })
    await f.c.refresh()
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["root", "tree"])
    expect(f.c.rows()[0].session.title).toBe("updated")
    expect(f.c.error()).toContain("metadata unavailable")
  })
  it("drops snapshots for locations that are no longer live, including after a failed poll", async () => {
    const f = setup([session("root", { outcome: "succeeded", location: { directory: "/other" } })])
    const live = vi.mocked(f.context.client.debug.location.list).mockResolvedValue([{ directory: "/other" }])
    vi.mocked(f.context.client.form.list).mockImplementation(async (input) => ({
      location: { directory: input?.location?.directory ?? "/project" }, data: input?.location?.directory === "/other" ? [{ id: "form", sessionID: "root", title: "Question", fields: [{ type: "string", key: "answer", title: "Which database?" }] }] : [],
    }))
    await f.c.refresh()
    expect(f.c.rows()[0].state).toBe("needs-input")
    vi.mocked(f.context.client.shell.list).mockRejectedValue(new Error("offline"))
    await f.c.refresh()
    expect(f.c.rows()[0].state).toBe("needs-input")
    live.mockResolvedValue([])
    await f.c.refresh()
    expect(f.c.rows()[0].state).toBe("completed")
    // A reappearing but still failing location must not resurrect an old inbox.
    live.mockResolvedValue([{ directory: "/other" }])
    await f.c.refresh()
    expect(f.c.rows()[0].state).toBe("completed")
  })
  it("bounds location fan-out even when an endpoint rejects before its siblings finish", async () => {
    vi.useFakeTimers()
    const f = setup()
    vi.mocked(f.context.client.debug.location.list).mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ directory: `/folder-${i}` })))
    let pending = 0
    let peak = 0
    let requests = 0
    const response = async (input: { location?: { directory?: string } } | undefined) => {
      pending++
      requests++
      peak = Math.max(peak, pending)
      await new Promise((resolve) => setTimeout(resolve, 10))
      pending--
      return { location: { directory: input?.location?.directory ?? "/project" }, data: [] }
    }
    vi.mocked(f.context.client.form.list).mockImplementation(response)
    vi.mocked(f.context.client.shell.list).mockImplementation(response)
    vi.mocked(f.context.client.permission.request.list).mockRejectedValue(new Error("unavailable"))
    const refreshing = f.c.refresh()
    await vi.advanceTimersByTimeAsync(100)
    await refreshing
    expect(requests).toBe(22)
    expect(peak).toBe(8)
    expect(pending).toBe(0)
    expect(f.c.rows()).toHaveLength(1)
  })
  it("hides missing live locations without failing the rest of the launch", async () => {
    const missing = session("missing", { location: { directory: "/deleted" } })
    const f = setup([session("root"), missing])
    f.cached.push(missing)
    f.c.select("missing")
    vi.mocked(f.context.client.debug.location.list).mockResolvedValue([{ directory: "/deleted" }])
    vi.mocked(f.context.client.shell.list).mockImplementation(async (input) => {
      if (input?.location?.directory === "/deleted") throw {
        _tag: "LocationNotFoundError", location: { directory: "/deleted" }, message: "Location not found",
      }
      return { location: { directory: "/project" }, data: [] }
    })
    await f.c.open()
    await f.c.refresh()
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["root"])
    expect(f.c.directories()).toEqual(["/project"])
    expect(f.c.selectedSession()).toBeUndefined()
    expect(f.c.error()).toBe("")
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.remove).not.toHaveBeenCalled()
    vi.mocked(f.context.client.shell.list).mockClear()
    await f.c.refresh()
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["root"])
    expect(f.context.client.shell.list).toHaveBeenCalledTimes(2)
  })
  it("quietly hides historical sessions when their preview location is missing", async () => {
    const missing = session("missing", { location: { directory: "/deleted" } })
    const f = setup([session("root"), missing])
    await f.c.refresh()
    vi.mocked(f.context.client.message.list).mockRejectedValue({
      _tag: "LocationNotFoundError", location: missing.location, message: "Location not found",
    })
    await f.c.loadPreview(missing, true)
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["root"])
    expect(f.c.directories()).toEqual(["/project"])
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.remove).not.toHaveBeenCalled()
    await f.c.refresh()
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["root", "missing"])
    expect(f.c.directories()).toEqual(["/deleted", "/project"])
  })
  it("stops, then hides a row while preserving its transcript", async () => {
    const f = setup()
    await f.c.refresh()
    await f.c.stopOrHide("root", 1000)
    expect(f.c.rows()).toHaveLength(1)
    expect(f.c.stopConfirmation()?.id).toBe("root")
    await f.c.stopOrHide("root", 2000)
    expect(f.c.rows()).toHaveLength(0)
    expect(f.c.stopConfirmation()).toBeUndefined()
    expect(f.remove).not.toHaveBeenCalled()
    await f.c.restoreHidden()
    expect(f.c.rows()).toHaveLength(1)
  })
  it("stops and hides a batch atomically, and undoes the whole batch", async () => {
    const f = setup([session("first"), session("second"), session("third")])
    await f.c.refresh()
    await f.c.stopOrHide("first", 1000)
    await f.c.stopOrHide("first", 2000)
    f.interrupt.mockClear()
    await f.c.stopOrHide(["second", "third", "second"], 3000)
    expect(f.interrupt.mock.calls.map(([input]) => input.sessionID)).toEqual(["second", "third"])
    expect(f.c.stopConfirmation()?.ids).toEqual(["second", "third"])
    expect(f.c.preferences.hidden).toEqual(["first"])
    await f.c.stopOrHide(["third", "second"], 4000)
    expect(f.c.preferences.hidden).toEqual(["first", "third", "second"])
    expect(f.c.stopConfirmation()).toBeUndefined()
    await f.c.undoHide()
    expect(f.c.preferences.hidden).toEqual(["first"])
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["second", "third"])
    expect(f.c.lastHidden()).toBeUndefined()
    expect(f.remove).not.toHaveBeenCalled()
  })
  it("requires a fresh stop when the selected batch changes or confirmation expires", async () => {
    const f = setup([session("first"), session("second"), session("third")])
    await f.c.refresh()
    await f.c.stopOrHide(["first", "second"], 1000)
    await f.c.stopOrHide(["first", "third"], 1500)
    expect(f.c.preferences.hidden).toEqual([])
    expect(f.c.stopConfirmation()?.ids).toEqual(["first", "third"])
    await f.c.stopOrHide(["first", "third"], 4000)
    expect(f.c.preferences.hidden).toEqual([])
    expect(f.interrupt).toHaveBeenCalledTimes(6)
    await f.c.stopOrHide([], 4500)
    expect(f.interrupt).toHaveBeenCalledTimes(6)
  })
  it("attempts every batch interruption even if one session fails", async () => {
    const f = setup([session("first"), session("second")])
    await f.c.refresh()
    f.interrupt.mockRejectedValueOnce(new Error("stop failed"))
    await expect(f.c.stopOrHide(["first", "second"], 1000)).rejects.toThrow("stop failed")
    expect(f.interrupt).toHaveBeenCalledTimes(2)
    expect(f.c.preferences.hidden).toEqual([])
    expect(f.list).toHaveBeenCalledTimes(2)
  })
  it("pins a mixed batch together and unpins a fully pinned batch", async () => {
    const f = setup([session("first"), session("second"), session("third")])
    await f.c.togglePin("first")
    await f.c.togglePin("third")
    await f.c.togglePin(["first", "second"])
    expect(f.c.preferences.pinned).toEqual(["first", "third", "second"])
    await f.c.togglePin(["first", "second"])
    expect(f.c.preferences.pinned).toEqual(["third"])
  })
  it("undoes only the last hidden session and preserves the draft and older hidden rows", async () => {
    const f = setup([session("first"), session("second")])
    await f.c.refresh()
    for (const id of ["first", "second"]) {
      await f.c.stopOrHide(id, 1000)
      await f.c.stopOrHide(id, 2000)
    }
    f.c.updateMemory((draft) => { draft.draft = "keep my task" })
    expect(f.c.lastHidden()).toBe("second")
    await f.c.undoHide()
    expect(f.c.rows().map((row) => row.session.id)).toEqual(["second"])
    expect(f.c.preferences.hidden).toEqual(["first"])
    expect(f.c.memory.draft).toBe("keep my task")
    expect(f.c.lastHidden()).toBeUndefined()
    await f.c.undoHide()
    expect(f.c.preferences.hidden).toEqual(["first"])
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.interrupt).toHaveBeenCalledTimes(2)
  })
  it("clears the stop confirmation when it expires or is cancelled", async () => {
    vi.useFakeTimers()
    const f = setup()
    await f.c.refresh()
    await f.c.stopOrHide("root")
    await vi.advanceTimersByTimeAsync(1999)
    expect(f.c.stopConfirmation()?.id).toBe("root")
    await vi.advanceTimersByTimeAsync(1)
    expect(f.c.stopConfirmation()).toBeUndefined()
    await f.c.stopOrHide("root")
    expect(f.c.rows()).toHaveLength(1)
    expect(f.c.stopConfirmation()?.id).toBe("root")
    f.c.clearStopConfirmation()
    expect(f.c.stopConfirmation()).toBeUndefined()
  })
  it("unsubscribes, cancels timers and aborts outstanding requests on unload", async () => {
    vi.useFakeTimers()
    const f = setup()
    await f.c.refresh()
    const signal = f.list.mock.calls[0][1].signal as AbortSignal
    f.c.dispose()
    expect(signal.aborted).toBe(true)
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.list).toHaveBeenCalledOnce()
  })
})
