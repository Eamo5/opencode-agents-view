import type { FormInfo, ModelRef, PermissionRequest, SessionInfo, SessionMessageInfo, ShellInfo } from "@opencode/client"
import type { Context, Route } from "@opencode/plugin/tui/context"
import { batch, createSignal } from "solid-js"
import { directoryKey, groupRows, messageSummary, requestSummary, rootSession, stateOf, uniqueDirectories, type Grouping, type Row } from "./model.ts"
import { isAgentsView, PAGE } from "./navigation.ts"
import type { Options } from "./options.ts"

interface Preferences {
  grouping: Grouping
  layoutVersion?: number
  pinned: string[]
  hidden: string[]
  defaultToAgentsView: boolean | null
}
interface Memory {
  selected: string | null
  selectedDirectory: string | null
  previous: Route
  draft: string
  stashed?: string[]
  replies: Record<string, string>
  peek: boolean
  startupHandled: boolean
  agent: string | null
  agentSelected?: boolean
  model: ModelRef | null
  modelInitialized?: boolean
}

export function createController(context: Context, options: Options) {
  // The host location follows the attached session. Snapshot the launch
  // location so an empty launch folder survives navigation and refreshes.
  const launchLocation = { ...(context.location ?? context.data.location.default()) }
  const [preferences, updatePreferences] = context.storage.store<Preferences>("preferences", {
    initial: { grouping: "directory", pinned: [], hidden: [], defaultToAgentsView: null },
  })
  const [memory, updateMemory] = context.storage.memory<Memory>("navigation", {
    initial: {
      selected: null, selectedDirectory: null, previous: { type: "home" }, draft: "", replies: {}, peek: false,
      startupHandled: false, agent: null, model: null,
    },
  })
  const [sessions, setSessions] = createSignal<SessionInfo[]>([])
  const [active, setActive] = createSignal<Set<string>>(new Set())
  const [shells, setShells] = createSignal<ShellInfo[]>([])
  const [permissions, setPermissions] = createSignal<PermissionRequest[]>([])
  const [forms, setForms] = createSignal<FormInfo[]>([])
  const [previews, setPreviews] = createSignal<Record<string, SessionMessageInfo[]>>({})
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [refreshGeneration, setRefreshGeneration] = createSignal(0)
  const [projectID, setProjectID] = createSignal<string>()
  const [missingDirectories, setMissingDirectories] = createSignal<Set<string>>(new Set())
  const abort = new AbortController()
  const requestOptions = { signal: abort.signal }
  const previewVersions = new Map<string, number>()
  const previewFetchedAt = new Map<string, number>()
  const previewPending = new Set<string>()
  const checkedDirectories = new Set<string>()
  let refreshPromise: Promise<void> | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let stopped: { id: string; until: number } | undefined
  let disposed = false

  const location = () => launchLocation
  const available = (directory: string) => !missingDirectories().has(directoryKey(directory))
  const hideMissingLocation = (cause: unknown) => {
    if (!cause || typeof cause !== "object" || !("_tag" in cause) || cause._tag !== "LocationNotFoundError" ||
      !("location" in cause) || !cause.location || typeof cause.location !== "object" ||
      !("directory" in cause.location) || typeof cause.location.directory !== "string") return false
    const key = directoryKey(cause.location.directory)
    if (!disposed) {
      setMissingDirectories((current) => new Set([...current, key]))
      if (memory.selectedDirectory && directoryKey(memory.selectedDirectory) === key) {
        updateMemory((draft) => { draft.selectedDirectory = null })
      }
    }
    return true
  }
  // Earlier releases defaulted to state buckets. Adopt the folder-first layout
  // for existing installs too; an explicit toggle then persists the choice.
  const grouping = () => preferences.layoutVersion === 1 ? preferences.grouping : "directory"
  const allSessions = () => {
    const result = new Map(sessions().map((session) => [session.id, session]))
    for (const session of context.data.session.list()) {
      const current = result.get(session.id)
      if (!current || session.time.updated >= current.time.updated) result.set(session.id, session)
    }
    return result
  }
  const inScope = (session: SessionInfo) => available(session.location.directory) && (options.scope === "all" ||
    (projectID() ? session.projectID === projectID() : directoryKey(session.location.directory) === directoryKey(location().directory)))
  const directories = () => uniqueDirectories([location().directory, ...(loading() ? [] : [...allSessions().values()])
    .filter((session) => !session.parentID && inScope(session))
    .toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
    .map((session) => session.location.directory)])
    .filter(available)
    .toSorted((a, b) => directoryKey(a).localeCompare(directoryKey(b)))
  const familyRequests = (sessionID: string, index = allSessions()) => {
    const family = new Set([sessionID, ...context.data.session.family(sessionID)])
    const belongs = (id: string) => family.has(id) || rootSession(id, index) === sessionID
    const pendingPermissions = new Map(permissions().filter((item) => belongs(item.sessionID)).map((item) => [item.id, item]))
    const pendingForms = new Map(forms().filter((item) => belongs(item.sessionID)).map((item) => [item.id, item]))
    for (const id of family) {
      for (const item of context.data.session.permission.list(id) ?? []) pendingPermissions.set(item.id, item)
      for (const item of context.data.session.form.list(id) ?? []) pendingForms.set(item.id, item)
    }
    return { permissions: [...pendingPermissions.values()], forms: [...pendingForms.values()] }
  }
  const messages = (id: string) => {
    const result = new Map((previews()[id] ?? []).map((message) => [message.id, message]))
    for (const message of context.data.session.message.list(id)) {
      const previous = result.get(message.id)
      const changedAt = (item: SessionMessageInfo) => "completed" in item.time ? item.time.completed ?? item.time.created : item.time.created
      if (!previous || changedAt(message) >= changedAt(previous)) result.set(message.id, message)
    }
    return [...result.values()].toSorted((a, b) => a.time.created - b.time.created)
  }
  const rows = (): Row[] => {
    // Cached inventory is unvalidated during launch; locally created sessions
    // are already backed by a successful server request and remain recoverable.
    const index = loading() ? new Map(sessions().map((session) => [session.id, session])) : allSessions()
    const running = new Set([...active()].map((id) => rootSession(id, index)))
    const background = new Map<string, ShellInfo[]>()
    for (const shell of shells()) {
      if (shell.status !== "running" || typeof shell.metadata.sessionID !== "string") continue
      const root = rootSession(shell.metadata.sessionID, index)
      background.set(root, [...(background.get(root) ?? []), shell])
    }
    return [...index.values()].filter((session) => !session.parentID && !session.time.archived &&
      !preferences.hidden.includes(session.id) && inScope(session))
      .map((session) => {
        const requests = familyRequests(session.id, index)
        const jobs = background.get(session.id) ?? []
        const state = stateOf(session, running.has(session.id) || context.data.session.status(session.id) === "running",
          requests.permissions.length + requests.forms.length > 0, jobs.length > 0)
        return {
          session, state, pinned: preferences.pinned.includes(session.id),
          summary: requestSummary(requests.permissions, requests.forms) ||
            (state === "background-shell" ? `${jobs.length} running shell${jobs.length === 1 ? "" : "s"}: ${jobs.map((shell) => shell.command).join(" · ")}` :
              messageSummary(messages(session.id))),
        }
      })
  }
  const selected = () => rows().find((row) => row.session.id === memory.selected)
  const selectedSession = () => {
    const id = memory.selected
    if (!id) return undefined
    const loaded = sessions().find((session) => session.id === id)
    const cached = context.data.session.get(id)
    const session = cached && (!loaded || cached.time.updated >= loaded.time.updated) ? cached : loaded
    return session && !session.parentID && !session.time.archived && !preferences.hidden.includes(id) && inScope(session) ? session : undefined
  }
  const dispatchLocation = () => ({ directory: memory.selectedDirectory ?? selectedSession()?.location.directory ?? location().directory })
  const select = (sessionID: string | null) => updateMemory((draft) => {
    draft.selected = sessionID
    draft.selectedDirectory = null
  })
  const selectDirectory = (directory: string) => updateMemory((draft) => {
    draft.selected = null
    draft.selectedDirectory = directory
    draft.peek = false
    // A session search must not immediately replace an explicit folder target.
    if (/^[anso]:/i.test(draft.draft)) draft.draft = ""
  })
  const report = (cause: unknown) => {
    if (disposed || hideMissingLocation(cause)) return
    context.ui.toast.show({ title: "Agents view", message: cause instanceof Error ? cause.message : String(cause), variant: "error" })
  }
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      try {
        const collected: SessionInfo[] = []
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          const page = await context.client.session.list(cursor ? { cursor } : { limit: 100, order: "desc" }, requestOptions)
          collected.push(...page.data)
          cursor = page.cursor.next ?? undefined
          if (cursor && seen.has(cursor)) throw new Error("Session pagination returned a repeated cursor")
          if (cursor) seen.add(cursor)
        } while (cursor)
        const [running, currentLocation, liveLocations] = await Promise.all([
          context.client.session.active(requestOptions),
          context.client.location.get({ location: location() }, requestOptions).catch((cause) => {
            if (!hideMissingLocation(cause)) throw cause
            return undefined
          }),
          context.client.debug.location.list(requestOptions),
        ])
        checkedDirectories.add(directoryKey(location().directory))
        // Validate each historical folder before publishing its sessions. A
        // message preview can succeed even when the session's folder is gone.
        const unchecked = uniqueDirectories([...collected, ...context.data.session.list()]
          .map((session) => session.location.directory))
          .filter((directory) => available(directory) && !checkedDirectories.has(directoryKey(directory)))
        for (let index = 0; index < unchecked.length && !disposed; index += 4) {
          await Promise.all(unchecked.slice(index, index + 4).map(async (directory) => {
            try {
              await context.client.location.get({ location: { directory } }, requestOptions)
              checkedDirectories.add(directoryKey(directory))
            } catch (cause) {
              if (!hideMissingLocation(cause)) throw cause
            }
          }))
        }
        // Only live locations can hold pending requests. Loading historical
        // inboxes is unnecessary, and missing folders have been filtered out.
        const liveDirectories = uniqueDirectories([location().directory, ...liveLocations.map((item) => item.directory), ...collected
          .filter((session) => running[session.id]).map((session) => session.location.directory)]).filter(available)
        const requests = await Promise.all(liveDirectories.map(async (directory) => {
          const [permission, form, shell] = await Promise.all([
            context.client.permission.request.list({ location: { directory } }, requestOptions),
            context.client.form.list({ location: { directory } }, requestOptions),
            context.client.shell.list({ location: { directory } }, requestOptions),
          ])
          return { permissions: permission.data, forms: form.data, shells: shell.data }
        }).map((request) => request.catch((cause) => {
          if (!hideMissingLocation(cause)) throw cause
          return { permissions: [], forms: [], shells: [] }
        })))
        if (disposed) return
        const index = new Map(collected.map((session) => [session.id, session]))
        // Streaming output need not change a session's inventory timestamp.
        // Reuse idle previews, but let the next visible batch refresh live roots.
        for (const id of Object.keys(running)) previewVersions.delete(rootSession(id, index))
        batch(() => {
          setSessions(collected)
          setProjectID(currentLocation?.project.id)
          setActive(new Set(Object.keys(running)))
          setShells(requests.flatMap((item) => item.shells))
          setPermissions(requests.flatMap((item) => item.permissions))
          setForms(requests.flatMap((item) => item.forms))
          setError("")
          setRefreshGeneration((value) => value + 1)
        })
      } catch (cause) {
        if (!disposed && !hideMissingLocation(cause)) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!disposed) setLoading(false)
        refreshPromise = undefined
      }
    })()
    return refreshPromise
  }
  const scheduleRefresh = () => {
    if (disposed || refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refresh()
    }, 150)
  }
  const stopEvents = context.data.listen(({ details }) => {
    // Token and progress events update the host cache already. They don't change
    // the inventory; fetching every page for them floods the server during output.
    if (details.type.endsWith(".delta") || details.type === "session.step.streamed" || details.type === "session.tool.progress") return
    if ((details.type.startsWith("session.") && !details.type.startsWith("session.message.")) ||
      details.type.startsWith("permission.") || details.type.startsWith("form.") || details.type.startsWith("shell.")) {
      scheduleRefresh()
    }
  })
  const interval = setInterval(() => void refresh(), options.refreshIntervalMs)

  async function loadPreview(session: SessionInfo, force = false) {
    const current = previewVersions.get(session.id) === session.time.updated
    if (disposed || !available(session.location.directory) || previewPending.has(session.id) || (current && (!force || Date.now() - (previewFetchedAt.get(session.id) ?? 0) < 1000))) return
    previewPending.add(session.id)
    try {
      const page = await context.client.message.list({ sessionID: session.id, limit: 8, order: "desc" }, requestOptions)
      if (disposed) return
      setPreviews((current) => ({ ...current, [session.id]: page.data.toSorted((a, b) => a.time.created - b.time.created) }))
      previewVersions.set(session.id, session.time.updated)
      previewFetchedAt.set(session.id, Date.now())
    } catch (cause) {
      if (!hideMissingLocation(cause) && force) report(cause)
    } finally {
      previewPending.delete(session.id)
    }
  }

  async function send(sessionID: string, text: string) {
    const command = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (command) {
      await context.client.session.command({ sessionID, name: command[1], text: command[2] ?? "", delivery: "queue" }, requestOptions)
    } else {
      await context.client.session.prompt({ sessionID, text, delivery: "queue" }, requestOptions)
    }
  }

  const open = async () => {
    const route = context.ui.router.current()
    if (isAgentsView(route)) return
    // Navigation exposes a live Solid store; snapshot it before any await.
    const previous = { ...route }
    const index = allSessions()
    const sessionID = previous.type === "session" ? rootSession(previous.sessionID, index) : undefined
    const model = context.ui.model.current()
    if (sessionID && preferences.hidden.includes(sessionID)) {
      try {
        await updatePreferences((draft) => { draft.hidden = draft.hidden.filter((id) => id !== sessionID) })
      } catch (cause) { report(cause); return }
    }
    if (disposed) return
    updateMemory((draft) => {
      draft.previous = previous
      if (previous.type === "session") {
        draft.selected = sessionID!
        draft.selectedDirectory = null
        const session = index.get(previous.sessionID)
        if (!draft.agentSelected) draft.agent = session?.agent ?? null
        // The prompt can hold a new selection that has not been submitted or
        // persisted on the session yet. Never resurrect the previous session's
        // model when switching to a conversation using configured defaults.
        draft.model = model ? { providerID: model.providerID, id: model.modelID, variant: model.variant } : session?.model ?? null
        draft.modelInitialized = !!draft.model
      } else {
        if (!draft.agentSelected) draft.agent = null
        draft.model = model ? { providerID: model.providerID, id: model.modelID, variant: model.variant } : null
        draft.modelInitialized = !!draft.model
      }
    })
    context.ui.dialog.clear()
    context.ui.router.navigate({ type: "plugin", name: PAGE })
    void refresh()
  }
  const attach = (sessionID: string) => {
    select(sessionID)
    context.ui.router.navigate({ type: "session", sessionID })
  }
  const syncInitialModel = () => {
    if (memory.modelInitialized || memory.model) return
    const model = context.ui.model.current()
    if (!model) return
    updateMemory((draft) => {
      draft.model = { providerID: model.providerID, id: model.modelID, variant: model.variant }
      draft.modelInitialized = true
    })
  }
  const createSession = async (directory: string, title?: string) => {
    syncInitialModel()
    const cursor = { selected: memory.selected, directory: memory.selectedDirectory }
    const created = await context.client.session.create({
      location: { directory }, title,
      agent: memory.agent ?? undefined, model: memory.model ?? undefined,
      metadata: { agentsView: true },
    }, requestOptions)
    if (!disposed) {
      // Keep a recoverable row even if prompt admission subsequently fails.
      setSessions((current) => [created, ...current.filter((session) => session.id !== created.id)])
      // A slow create must not replace a target the user chose for their next task.
      if (memory.selected === cursor.selected && memory.selectedDirectory === cursor.directory) select(created.id)
    }
    return created
  }

  return {
    context, options, preferences, memory, updateMemory, location, directories, available, dispatchLocation, select, selectDirectory,
    rows, selected, selectedSession, loading, error, sending, refreshGeneration,
    grouping,
    groups: (query = "") => groupRows(rows(), grouping(), query, directories(), available(location().directory) ? location().directory : undefined),
    requests: familyRequests,
    messages,
    async loadPreviews(values: readonly SessionInfo[]) {
      for (let index = 0; index < values.length && !disposed; index += 4) {
        await Promise.all(values.slice(index, index + 4).map((session) => loadPreview(session)))
      }
    },
    loadPreview, refresh, report, open, attach, syncInitialModel,
    setDispatchAgent: (agent: string | null) => updateMemory((draft) => {
      draft.agent = agent
      draft.agentSelected = true
    }),
    back: () => context.ui.router.navigate(memory.previous),
    landingEnabled: () => preferences.defaultToAgentsView ?? options.defaultToAgentsView,
    async toggleLanding() {
      await updatePreferences((draft) => { draft.defaultToAgentsView = !(draft.defaultToAgentsView ?? options.defaultToAgentsView) })
      context.ui.toast.show({ message: `Open agents view by default: ${preferences.defaultToAgentsView ? "on" : "off"}` })
    },
    async toggleGrouping() {
      const next = grouping() === "state" ? "directory" : "state"
      await updatePreferences((draft) => { draft.grouping = next; draft.layoutVersion = 1 })
    },
    async togglePin(id: string) {
      await updatePreferences((draft) => {
        draft.pinned = draft.pinned.includes(id) ? draft.pinned.filter((value) => value !== id) : [...draft.pinned, id]
      })
    },
    async restoreHidden() {
      await updatePreferences((draft) => { draft.hidden = [] })
    },
    async rename(id: string, title: string) {
      await context.client.session.update({ sessionID: id, title }, requestOptions)
      await refresh()
    },
    async stopOrHide(id: string, now = Date.now()) {
      if (stopped?.id === id && now <= stopped.until) {
        await updatePreferences((draft) => { if (!draft.hidden.includes(id)) draft.hidden.push(id) })
        stopped = undefined
        return
      }
      stopped = { id, until: now + 2000 }
      try {
        await context.client.session.interrupt({ sessionID: id, resume: false }, requestOptions)
        context.ui.toast.show({ message: "Session stopped. Press Ctrl+X again within 2 seconds to hide it." })
      } finally {
        await refresh()
      }
    },
    clearStopConfirmation: () => { stopped = undefined },
    async newSession(directory = dispatchLocation().directory) {
      if (sending() || disposed) return false
      setSending(true)
      try {
        const created = await createSession(directory)
        if (disposed) return false
        context.ui.tabs.open(created.id)
        attach(created.id)
        await refresh()
        return true
      } catch (cause) {
        report(cause)
        return false
      } finally {
        if (!disposed) setSending(false)
      }
    },
    async dispatch(text: string, attachImmediately = false) {
      if (disposed || !text.trim() || sending()) return false
      setSending(true)
      let created: SessionInfo | undefined
      try {
        created = await createSession(dispatchLocation().directory, text.trim().replace(/\s+/g, " ").slice(0, 80))
        if (disposed) return false
        await send(created.id, text)
        if (disposed) return false
        updateMemory((draft) => { if (draft.draft === text) draft.draft = "" })
        context.ui.tabs.open(created.id)
        if (attachImmediately) attach(created.id)
        await refresh()
        return true
      } catch (cause) {
        report(cause)
        if (created && !disposed) context.ui.toast.show({ message: "Session created; prompt was not delivered. Your draft was kept. Attach to retry.", sessionID: created.id, variant: "warning" })
        return false
      } finally {
        if (!disposed) setSending(false)
      }
    },
    async reply(sessionID: string, text: string) {
      if (disposed || !text.trim() || sending()) return false
      setSending(true)
      try {
        if (text.trim() === "/stop") await context.client.session.interrupt({ sessionID, resume: false }, requestOptions)
        else await send(sessionID, text)
        if (disposed) return false
        updateMemory((draft) => { if (draft.replies[sessionID] === text) delete draft.replies[sessionID] })
        await refresh()
        return true
      } catch (cause) {
        report(cause)
        return false
      } finally {
        if (!disposed) setSending(false)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      abort.abort()
      clearInterval(interval)
      if (refreshTimer) clearTimeout(refreshTimer)
      stopEvents()
    },
  }
}

export type Controller = ReturnType<typeof createController>
