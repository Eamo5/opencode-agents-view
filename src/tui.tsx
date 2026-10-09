import { Plugin } from "@opencode/plugin/tui"
import { CliRenderEvents } from "@opentui/core"
import { Show, createEffect, createSignal, on, onMount } from "solid-js"
import { createController } from "./controller.ts"
import { canDetach, isAgentsView, PAGE, shouldOpenOnStartup } from "./navigation.ts"
import { parseOptions } from "./options.ts"
import { AgentsView } from "./view.tsx"
import { createSessionHistory } from "./history.ts"

export default Plugin.define({
  id: "agents.view",
  setup(context) {
    const options = parseOptions(context.options)
    const controller = createController(context, options)
    const [promptMode, setPromptMode] = createSignal("normal")
    const history = createSessionHistory(context, () => promptMode() === "normal")
    // Renderer focus is an event, not a Solid getter. A reactive target is
    // essential: otherwise the binding remains tied to a destroyed prompt
    // after the first attach/detach cycle.
    const [focusedEditor, setFocusedEditor] = createSignal(context.renderer.currentFocusedEditor)
    const focusChanged = (editor: typeof context.renderer.currentFocusedEditor) => setFocusedEditor(editor)
    context.renderer.on(CliRenderEvents.FOCUSED_EDITOR, focusChanged)
    context.ui.router.register({ name: PAGE, render: () => <AgentsView controller={controller} /> })
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        createEffect(() => setPromptMode(input.mode))
        return <Show when={input.mode === "normal" && options.leftArrowOpensAgents}>
          <text fg={context.theme.text.muted} onMouseUp={(event) => { if (event.button === 0) controller.open() }}>
            {(() => {
              const count = controller.rows().filter((row) => row.state === "needs-input" && row.session.id !== input.sessionID).length
              return count ? `← ${count > 99 ? "99+" : count} agents` : "← for agents"
            })()}
          </text>
        </Show>
      },
    })
    context.ui.slot({
      append: "app",
      render() {
        // V2.0.20–2.0.25 resolve Keymap.Provider from the current Solid owner.
        // Mount bindings here (not in setup) so they inherit the host context
        // and are disposed with this contribution on every supported release.
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "agents.view.open", title: "Open agents view", group: "Agents", palette: true,
              slash: { name: "agents-view", aliases: ["av", "bg", "background"] }, bind: "ctrl+g",
              run: controller.open,
            },
            {
              id: "agents.view.default", title: "Toggle: open agents view by default", group: "Agents", palette: true,
              run: () => { void controller.toggleLanding().catch(controller.report) },
            },
            {
              id: "agents.view.restore", title: "Restore hidden agents", group: "Agents", palette: true,
              run: () => { void controller.restoreHidden().catch(controller.report) },
            },
          ],
        }))
        context.keymap.layer(() => ({
          mode: "base", priority: 10, target: focusedEditor,
          enabled: () => options.leftArrowOpensAgents && !isAgentsView(context.ui.router.current()),
          commands: [{
            id: "agents.view.back", title: "Back to agents view (empty prompt)", bind: "left",
            run: () => {
              // Inspect the public focused-editor API at dispatch time: text changes
              // are not reactive, and disabling the whole binding would steal Left.
              if (promptMode() !== "normal" || !canDetach(context.ui.router.current(), context.keymap.mode.current(), context.renderer.currentFocusedEditor)) return false
              return controller.open()
            },
          }],
        }))
        context.keymap.layer(() => ({
          mode: "base", priority: 10, target: focusedEditor,
          enabled: () => options.sessionOnlyHistory && promptMode() === "normal" && context.ui.router.current().type === "session",
          commands: [
            { bind: "up", title: "Previous prompt in this chat", run: () => history.move(-1) },
            { bind: "down", title: "Next prompt in this chat", run: () => history.move(1) },
          ],
        }))
        createEffect(on([
          () => {
            const route = context.ui.router.current()
            return route.type === "session" ? route.sessionID : route.type
          },
          focusedEditor, promptMode, () => context.keymap.mode.current(),
        ], () => history.reset()))
        // Execute once after the host mounts. Reloading a plugin or returning
        // home must never re-apply the startup preference.
        onMount(() => {
          if (controller.memory.startupHandled) return
          controller.updateMemory((memory) => { memory.startupHandled = true })
          if (shouldOpenOnStartup(context.ui.router.current(),
            process.env.OPENCODE_AGENTS_VIEW === "1" || controller.landingEnabled(), process.argv.slice(2))) controller.open()
        })
        createEffect(() => {
          if (isAgentsView(context.ui.router.current())) void controller.refresh()
        })
        return null
      },
    })
    void controller.refresh()
    return () => {
      context.renderer.off(CliRenderEvents.FOCUSED_EDITOR, focusChanged)
      controller.dispose()
      history.dispose()
    }
  },
})
