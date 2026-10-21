import type { FormInfo, ModelRef, PermissionRequest, SessionInfo, SessionMessageInfo, ShellInfo } from "@opencode/client"
import type { Context, Route } from "@opencode/plugin/tui/context"
import { batch, createSignal } from "solid-js"
import { applyLayout, moveOrder, directoryKey, groupRows, messageSummary, requestSummary, rootSession, stateOf, uniqueDirectories, type Group, type Grouping, type LayoutOrder, type Row } from "./model.ts"
import { isAgentsView, PAGE } from "./navigation.ts"
import type { Options } from "./options.ts"
import { skillMentions } from "./completion.ts"

interface Preferences {
  grouping: Grouping
  layoutVersion?: number
  pinned: string[]
  hidden: string[]
  collapsedDirectories?: string[]
  order?: LayoutOrder
  defaultToAgentsView: boolean | null
}
interface Memory {
  selected: string | null
  selectedDirectory: string | null
  previous: Route
  draft: string
  replies: Record<string, string>
  peek: boolean
  startupHandled: boolean
  agent: string | null
  agentSelected?: boolean
  model: ModelRef | null
  modelInitialized?: boolean
  modelSelected?: boolean
  lastHidden?: string
  lastHiddenBatch?: string[]
}

interface LocationSnapshot {
  permissions: PermissionRequest[]
  forms: FormInfo[]
  shells: ShellInfo[]
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
  const [promptTimes, setPromptTimes] = createSignal<Record<string, number>>({})
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const [refreshFailed, setRefreshFailed] = createSignal(false)
  const [sending, setSending] = createSignal(false)
  const [refreshGeneration, setRefreshGeneration] = createSignal(0)
  const [projectID, setProjectID] = createSignal<string>()
  const [missingDirectories, setMissingDirectories] = createSignal<Set<string>>(new Set())
  const [unverifiedDirectories, setUnverifiedDirectories] = createSignal<Set<string>>(new Set())
  const abort = new AbortController()
  const requestOptions = { signal: abort.signal }
  const previewVersions = new Map<string, number>()
  const previewFetchedAt = new Map<string, number>()
  const previewPending = new Set<string>()
  const promptVersions = new Map<string, number>()
  const checkedDirectories = new Set<string>()
  const locationSnapshots = new Map<string, LocationSnapshot>()
  let refreshPromise: Promise<void> | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const [stopped, setStopped] = createSignal<{ id: string; ids: string[]; until: number }>()
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  // Models switched here, checked once when their chat is next attached.
  const switchedModels = new Map<string, ModelRef>()
  let modelCheckTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const clearStopConfirmation = () => {
    if (stopTimer) clearTimeout(stopTimer)
    stopTimer = undefined
    setStopped(undefined)
  }

  const location = () => launchLocation
  const available = (directory: string) => !missingDirectories().has(directoryKey(directory)) && !unverifiedDirectories().has(directoryKey(directory))
  const restoreLocation = (directory: string) => {
    if (disposed) return
    const key = directoryKey(directory)
    checkedDirectories.add(key)
    if (unverifiedDirectories().has(key)) setUnverifiedDirectories((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
    if (missingDirectories().has(key)) setMissingDirectories((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }
  const hideMissingLocation = (cause: unknown) => {
    if (!cause || typeof cause !== "object" || !("_tag" in cause) || cause._tag !== "LocationNotFoundError" ||
      !("location" in cause) || !cause.location || typeof cause.location !== "object" ||
      !("directory" in cause.location) || typeof cause.location.directory !== "string") return false
    const key = directoryKey(cause.location.directory)
    if (!disposed) {
      checkedDirectories.delete(key)
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
  const isCollapsed = (directory: string) => preferences.collapsedDirectories?.includes(directoryKey(directory)) ?? false
  const lastHidden = () => memory.lastHidden && preferences.hidden.includes(memory.lastHidden) ? memory.lastHidden : undefined
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
        const history = messages(session.id)
        const requests = familyRequests(session.id, index)
        const jobs = background.get(session.id) ?? []
        const state = stateOf(session, running.has(session.id) || context.data.session.status(session.id) === "running",
          requests.permissions.length + requests.forms.length > 0, jobs.length > 0)
        return {
          session, state, pinned: preferences.pinned.includes(session.id),
          lastPromptAt: history.reduce((latest, message) => message.type === "user" ?
            Math.max(latest, message.time.created) : latest, promptTimes()[session.id] ?? 0) || session.time.created,
          summary: requestSummary(requests.permissions, requests.forms) ||
            (state === "background-shell" ? `${jobs.length} running shell${jobs.length === 1 ? "" : "s"}: ${jobs.map((shell) => shell.command).join(" · ")}` :
              messageSummary(history)),
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
  const recordPrompt = (sessionID: string, created: number) => {
    if (disposed || created <= (promptTimes()[sessionID] ?? 0)) return
    setPromptTimes((current) => ({ ...current, [sessionID]: created }))
  }
  async function loadPromptTimes() {
    const values = rows().map((row) => row.session).filter((session) => promptVersions.get(session.id) !== session.time.updated)
    for (let index = 0; index < values.length && !disposed; index += 4) {
      await Promise.all(values.slice(index, index + 4).map(async (session) => {
        try {
          // A short output preview may not include the latest user prompt.
          // Fetch only that prompt, including for collapsed or off-screen rows.
          const page = await context.client.message.list({ sessionID: session.id, type: "user", order: "desc", limit: 1 }, requestOptions)
          if (disposed) return
          for (const message of page.data) {
            if (message.type === "user") recordPrompt(session.id, message.time.created)
          }
          promptVersions.set(session.id, session.time.updated)
        } catch (cause) {
          // Preserve the last known order on transient failures and retry later.
          hideMissingLocation(cause)
        }
      }))
    }
  }
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      try {
        const failures: string[] = []
        const locationFailure = (directory: string, cause: unknown, validating = false) => {
          if (disposed || hideMissingLocation(cause)) return
          failures.push(`${directory}: ${cause instanceof Error ? cause.message : String(cause)}`)
          // A new folder must pass validation before its inventory is displayed.
          // Previously validated folders keep their last-known state on failure.
          if (validating && !checkedDirectories.has(directoryKey(directory))) {
            setUnverifiedDirectories((current) => new Set([...current, directoryKey(directory)]))
          }
        }
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
            locationFailure(location().directory, cause, true)
            return undefined
          }),
          context.client.debug.location.list(requestOptions),
        ])
        if (currentLocation) restoreLocation(location().directory)
        // Validate each historical folder before publishing its sessions. A
        // message preview can succeed even when the session's folder is gone.
        const unchecked = uniqueDirectories([...collected, ...context.data.session.list()]
          .map((session) => session.location.directory))
          .filter((directory) => directoryKey(directory) !== directoryKey(location().directory) &&
            !checkedDirectories.has(directoryKey(directory)))
        for (let index = 0; index < unchecked.length && !disposed; index += 4) {
          await Promise.all(unchecked.slice(index, index + 4).map(async (directory) => {
            try {
              await context.client.location.get({ location: { directory } }, requestOptions)
              restoreLocation(directory)
            } catch (cause) {
              locationFailure(directory, cause, true)
            }
          }))
        }
        // Only live locations can hold pending requests. Loading historical
        // inboxes is unnecessary, and missing folders have been filtered out.
        const liveDirectories = uniqueDirectories([location().directory, ...liveLocations.map((item) => item.directory), ...collected
          .filter((session) => running[session.id]).map((session) => session.location.directory)]).filter(available)
        // Bound fan-out to four locations (at most twelve requests). Wait for
        // every endpoint before freeing a slot, including when one rejects.
        const nextSnapshots = new Map<string, LocationSnapshot>()
        for (let index = 0; index < liveDirectories.length && !disposed; index += 4) {
          await Promise.all(liveDirectories.slice(index, index + 4).map(async (directory) => {
            const key = directoryKey(directory)
            const results = await Promise.allSettled([
              context.client.permission.request.list({ location: { directory } }, requestOptions),
              context.client.form.list({ location: { directory } }, requestOptions),
              context.client.shell.list({ location: { directory } }, requestOptions),
            ])
            if (disposed) return
            const [permission, form, shell] = results
            if (permission.status === "fulfilled" && form.status === "fulfilled" && shell.status === "fulfilled") {
              nextSnapshots.set(key, { permissions: permission.value.data, forms: form.value.data, shells: shell.value.data })
              return
            }
            for (const result of results) {
              if (result.status === "rejected") locationFailure(directory, result.reason)
            }
            const previous = locationSnapshots.get(key)
            if (available(directory) && previous) nextSnapshots.set(key, previous)
          }))
        }
        if (disposed) return
        locationSnapshots.clear()
        for (const [key, snapshot] of nextSnapshots) locationSnapshots.set(key, snapshot)
        const requests = [...locationSnapshots.values()]
        const index = new Map(collected.map((session) => [session.id, session]))
        // Streaming output need not change a session's inventory timestamp.
        // Reuse idle previews, but let the next visible batch refresh live roots.
        for (const id of Object.keys(running)) previewVersions.delete(rootSession(id, index))
        batch(() => {
          setSessions(collected)
          if (currentLocation) setProjectID(currentLocation.project.id)
          setActive(new Set(Object.keys(running)))
          setShells(requests.flatMap((item) => item.shells))
          setPermissions(requests.flatMap((item) => item.permissions))
          setForms(requests.flatMap((item) => item.forms))
          setRefreshFailed(false)
          setError(failures.length ? `${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more failures)` : ""}` : "")
          setRefreshGeneration((value) => value + 1)
        })
        await loadPromptTimes()
      } catch (cause) {
        if (!disposed && !hideMissingLocation(cause)) batch(() => {
          setError(cause instanceof Error ? cause.message : String(cause))
          setRefreshFailed(true)
        })
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
    if (details.type === "session.inbox.enqueued" && details.data.item.type === "user") {
      recordPrompt(details.data.sessionID, details.created)
    }
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
    const body = command ? command[2] ?? "" : text
    const session = allSessions().get(sessionID)
    const skills = /(^|\s)@/.test(body) ? skillMentions(body, (await context.client.skill.list({
      location: session?.location ?? dispatchLocation(),
    }, requestOptions)).data) : undefined
    const attachments = skills ? { skills } : {}
    const created = Date.now()
    if (command) {
      await context.client.session.command({ sessionID, name: command[1], text: body, ...attachments, delivery: "queue" }, requestOptions)
      recordPrompt(sessionID, created)
    } else {
      const prompt = await context.client.session.prompt({ sessionID, text, ...attachments, delivery: "queue" }, requestOptions)
      recordPrompt(sessionID, prompt?.time?.created ?? created)
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
         if (!draft.modelSelected) {
           draft.model = model ? { providerID: model.providerID, id: model.modelID, variant: model.variant } : session?.model ?? null
           draft.modelInitialized = !!draft.model
         }
      } else {
        if (!draft.agentSelected) draft.agent = null
        if (!draft.modelSelected) {
          draft.model = model ? { providerID: model.providerID, id: model.modelID, variant: model.variant } : null
          draft.modelInitialized = !!draft.model
        }
      }
    })
    context.ui.dialog.clear()
    context.ui.router.navigate({ type: "plugin", name: PAGE })
    void refresh()
  }
  const attach = (sessionID: string) => {
    select(sessionID)
    context.ui.router.navigate({ type: "session", sessionID })
    const expected = switchedModels.get(sessionID)
    if (!expected) return
    switchedModels.delete(sessionID)
    // OpenCode keeps a model picked inside a chat over one switched by another
    // client, and plugins cannot clear that choice. Warn before it is used.
    if (modelCheckTimer) clearTimeout(modelCheckTimer)
    modelCheckTimer = setTimeout(() => {
      modelCheckTimer = undefined
      const route = context.ui.router.current()
      const current = context.ui.model.current()
      if (disposed || route.type !== "session" || route.sessionID !== sessionID || !current ||
        (current.providerID === expected.providerID && current.modelID === expected.id)) return
      context.ui.toast.show({
        variant: "warning", duration: 8000,
        message: `This chat will still use ${current.modelID}, picked earlier in this chat, not ${expected.id}. Use /models here to switch.`,
      })
    }, 250)
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
      restoreLocation(created.location.directory)
      // Keep a recoverable row even if prompt admission subsequently fails.
      setSessions((current) => [created, ...current.filter((session) => session.id !== created.id)])
      // A slow create must not replace a target the user chose for their next task.
      if (memory.selected === cursor.selected && memory.selectedDirectory === cursor.directory) select(created.id)
    }
    return created
  }

  return {
    context, options, preferences, memory, updateMemory, location, directories, available, dispatchLocation, select, selectDirectory,
    rows, selected, selectedSession, loading, error, refreshFailed, sending, refreshGeneration, stopConfirmation: stopped,
    grouping, isCollapsed, lastHidden,
    arrange: (groups: Group[]) => applyLayout(groups, preferences.order),
    groups: (query = "") => applyLayout(groupRows(rows(), grouping(), query, directories(), available(location().directory) ? location().directory : undefined), preferences.order),
    async reorder(groups: Group[], offset: -1 | 1, directories: string | readonly string[] | null, ids: ReadonlySet<string>) {
      const keys = new Set((typeof directories === "string" ? [directories] : directories ?? []).map(directoryKey))
      await updatePreferences((draft) => {
        const order = draft.order ??= {}
        if (keys.size) {
          const folders = groups.filter((group) => group.directory)
          order.folders = moveOrder(folders.map((group) => group.id),
            new Set(folders.filter((group) => keys.has(directoryKey(group.directory!))).map((group) => group.id)), offset)
        } else {
          for (const group of groups) {
            if (!group.rows.some((row) => ids.has(row.session.id))) continue
            const sessions = order.sessions ??= {}
            sessions[group.id] = moveOrder(group.rows.map((row) => row.session.id), ids, offset)
          }
        }
      })
    },
    requests: familyRequests,
    messages,
    async loadPreviews(values: readonly SessionInfo[]) {
      for (let index = 0; index < values.length && !disposed; index += 4) {
        await Promise.all(values.slice(index, index + 4).map((session) => loadPreview(session)))
      }
    },
    loadPreview, refresh, report, open, attach, syncInitialModel,
    async setSessionModel(value: string | readonly string[], model: ModelRef) {
      const ids = [...new Set(typeof value === "string" ? [value] : value)]
      try {
        // Switch every selected chat even if one of them rejects.
        const results = await Promise.allSettled(ids.map((sessionID) =>
          context.client.session.switchModel({ sessionID, model }, requestOptions)))
        ids.forEach((sessionID, index) => {
          if (results[index].status === "fulfilled") switchedModels.set(sessionID, model)
        })
        const failure = results.find((result) => result.status === "rejected")
        if (failure?.status === "rejected") throw failure.reason
      } finally {
        await refresh()
      }
    },
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
    async togglePin(value: string | readonly string[]) {
      const ids = new Set(typeof value === "string" ? [value] : value)
      await updatePreferences((draft) => {
        const pin = [...ids].some((id) => !draft.pinned.includes(id))
        draft.pinned = pin ? [...new Set([...draft.pinned, ...ids])] : draft.pinned.filter((id) => !ids.has(id))
      })
    },
    async toggleDirectory(directory: string) {
      const key = directoryKey(directory)
      await updatePreferences((draft) => {
        const collapsed = draft.collapsedDirectories ?? []
        draft.collapsedDirectories = collapsed.includes(key) ? collapsed.filter((value) => value !== key) : [...collapsed, key]
      })
    },
    async undoHide() {
      const id = lastHidden()
      if (!id) return
      const ids = new Set(memory.lastHiddenBatch ?? [id])
      await updatePreferences((draft) => { draft.hidden = draft.hidden.filter((value) => !ids.has(value)) })
      updateMemory((draft) => { if (draft.lastHidden === id) { delete draft.lastHidden; delete draft.lastHiddenBatch } })
      context.ui.toast.show({ message: ids.size === 1 ? "Session restored" : `${ids.size} sessions restored` })
    },
    async restoreHidden() {
      await updatePreferences((draft) => { draft.hidden = [] })
      updateMemory((draft) => { delete draft.lastHidden; delete draft.lastHiddenBatch })
    },
    async rename(id: string, title: string) {
      await context.client.session.update({ sessionID: id, title }, requestOptions)
      await refresh()
    },
    async stopOrHide(value: string | readonly string[], now = Date.now()) {
      const ids = [...new Set(typeof value === "string" ? [value] : value)]
      if (!ids.length) return
      const confirmation = stopped()
      if (confirmation && now <= confirmation.until && confirmation.ids.length === ids.length &&
        ids.every((id) => confirmation.ids.includes(id))) {
        await updatePreferences((draft) => { draft.hidden = [...new Set([...draft.hidden, ...ids])] })
        updateMemory((draft) => { draft.lastHidden = ids.at(-1); draft.lastHiddenBatch = ids })
        clearStopConfirmation()
        context.ui.toast.show({ message: `${ids.length === 1 ? "Session hidden" : `${ids.length} sessions hidden`} · Ctrl+Z on an empty dashboard prompt to undo`, duration: 5000 })
        return
      }
      clearStopConfirmation()
      setStopped({ id: ids[0], ids, until: now + 2000 })
      stopTimer = setTimeout(clearStopConfirmation, 2000)
      try {
        // A failed interruption must not prevent the other selected sessions
        // from being stopped, or refresh before those requests have settled.
        const results = await Promise.allSettled(ids.map((sessionID) =>
          context.client.session.interrupt({ sessionID, resume: false }, requestOptions)))
        const failure = results.find((result) => result.status === "rejected")
        if (failure?.status === "rejected") throw failure.reason
      } finally {
        await refresh()
      }
    },
    clearStopConfirmation,
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
    async replyMany(sessionIDs: readonly string[], text: string) {
      const ids = [...new Set(sessionIDs)]
      if (disposed || !ids.length || !text.trim() || sending()) return
      setSending(true)
      try {
        const results = await Promise.allSettled(ids.map((sessionID) => text.trim() === "/stop" ?
          context.client.session.interrupt({ sessionID, resume: false }, requestOptions) : send(sessionID, text)))
        if (disposed) return
        const sent = ids.filter((_, index) => results[index].status === "fulfilled")
        const failed = ids.filter((_, index) => results[index].status === "rejected")
        if (!failed.length) updateMemory((draft) => { if (draft.draft === text) draft.draft = "" })
        const failure = results.find((result) => result.status === "rejected")
        if (failure?.status === "rejected") report(failure.reason)
        context.ui.toast.show({
          message: failed.length ? `Sent to ${sent.length} of ${ids.length} chats. Draft kept; retry failed chats only.` :
            `Sent to ${sent.length} selected chat${sent.length === 1 ? "" : "s"}`,
          variant: failed.length ? "warning" : "success",
        })
        await refresh()
        return { sent, failed }
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
      if (modelCheckTimer) clearTimeout(modelCheckTimer)
      clearStopConfirmation()
      stopEvents()
    },
  }
}

export type Controller = ReturnType<typeof createController>
