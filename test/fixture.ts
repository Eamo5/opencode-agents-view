import type { SessionInfo } from "@opencode/client"
import type { Context, Route } from "@opencode/plugin/tui/context"
import { vi } from "vitest"

export function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, projectID: "project", title: id, agent: "build", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1000, updated: 2000 }, location: { directory: "/project" }, ...overrides,
  }
}

export function fixture(initial: SessionInfo[] = []) {
  let route: Route = { type: "home" }
  let listener: Parameters<Context["data"]["listen"]>[0] | undefined
  const stores = new Map<string, object>()
  function store<Value extends object>(key: string, options: { initial: Value }) {
    if (!stores.has(key)) stores.set(key, structuredClone(options.initial))
    const value = stores.get(key) as Value
    return [value, (update: (draft: Value) => void) => { update(value); return Promise.resolve() }] as const
  }
  const list = vi.fn().mockResolvedValue({ data: initial, cursor: {} })
  const create = vi.fn().mockResolvedValue(session("created"))
  const prompt = vi.fn().mockResolvedValue({})
  const command = vi.fn().mockResolvedValue(undefined)
  const interrupt = vi.fn().mockResolvedValue({ interrupted: true })
  const remove = vi.fn()
  const notify = vi.fn()
  const unsubscribe = vi.fn()
  const navigate = vi.fn((destination: Route | Omit<Extract<Route, { type: "plugin" }>, "id">) => {
    route = destination.type === "plugin" ? { ...destination, id: "agents.view" } : destination
  })
  const cached: SessionInfo[] = []
  const context = {
    options: {}, location: { directory: "/project" },
    app: { version: "2.0.26", channel: "latest" },
    storage: { store, memory: store },
    client: {
      session: { list, create, prompt, command, interrupt, remove, update: vi.fn().mockResolvedValue(undefined), active: vi.fn().mockResolvedValue({}) },
      location: { get: vi.fn().mockResolvedValue({ directory: "/project", project: { id: "project" } }) },
      debug: { location: { list: vi.fn().mockResolvedValue([]) } },
      shell: { list: vi.fn().mockResolvedValue({ data: [] }) },
      permission: { request: { list: vi.fn().mockResolvedValue({ data: [] }) } },
      form: { list: vi.fn().mockResolvedValue({ data: [] }) },
      message: { list: vi.fn().mockResolvedValue({ data: [] }) },
    },
    data: {
      listen: (handler: typeof listener) => { listener = handler; return unsubscribe },
      location: { default: () => ({ directory: "/project" }) },
      session: {
        list: () => cached, get: (id: string) => cached.find((item) => item.id === id),
        family: () => [], status: () => "idle",
        message: { list: () => [] }, permission: { list: () => [] }, form: { list: () => [] },
      },
    },
    ui: {
      router: { current: () => route, navigate },
      model: { current: () => undefined }, dialog: { clear: vi.fn() },
      toast: { show: notify }, tabs: { open: vi.fn() },
    },
  } as unknown as Context
  return {
    context, stores, cached, list, create, prompt, command, interrupt, remove, notify, navigate, unsubscribe,
    route: () => route,
    setRoute: (value: Route) => { route = value },
    emit: (details: Parameters<NonNullable<typeof listener>>[0]["details"]) => listener?.({ details }),
  }
}
