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
    expect(messages).toHaveBeenCalledTimes(3)
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
  it("dispatches slash commands through the command API", async () => {
    const f = setup()
    await f.c.dispatch("/review staged changes")
    expect(f.command).toHaveBeenCalledWith({ sessionID: "created", name: "review", text: "staged changes", delivery: "queue" }, expect.anything())
    expect(f.prompt).not.toHaveBeenCalled()
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
    expect(f.context.client.message.list).not.toHaveBeenCalled()
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
    await f.c.stopOrHide("root", 2000)
    expect(f.c.rows()).toHaveLength(0)
    expect(f.remove).not.toHaveBeenCalled()
    await f.c.restoreHidden()
    expect(f.c.rows()).toHaveLength(1)
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
