# OpenCode Agents View

A Claude-style agents dashboard for the **OpenCode V2 terminal**, built with the public `@opencode/plugin/tui` API and OpenTUI/Solid.

```text
OpenCode v2.0.26 · Agents
Default model · ~/projects/app
1 awaiting input · 2 working · 1 completed

Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c quits

~/projects/app
  * review permissions      Needs input · Permission: edit src/auth.ts
  * fix login tests         Working · Running the test suite

~/projects/service
  * investigate timeout     Working · Reading the connection pool
  ✓ update documentation    Completed · Updated the getting-started guide

› Type a task to start an agent
↑↓ select · enter open · space peek · ctrl+n new · esc return · ctrl+c quit · ? help
```

## Install in OpenCode V2

Install the npm package [`opencode-agents-view`](https://www.npmjs.com/package/opencode-agents-view) through OpenCode's plugin configuration.

Add this entry to the `plugins` array in **`~/.config/opencode/cli.json`** (or `$XDG_CONFIG_HOME/opencode/cli.json`):

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "session": {
    "new_location": "inherit"
  },
  "plugins": [
    {
      "package": "opencode-agents-view",
      "options": {
        "defaultToAgentsView": true,
        "leftArrowOpensAgents": true
      }
    }
  ]
}
```

Merge the entry with your existing plugins, then quit and restart OpenCode. OpenCode resolves the npm package for you; no global `npm install` or local build is needed. To pin a release, use `opencode-agents-view@0.1.1`.

`session.new_location: "inherit"` makes OpenCode's built-in `/new` use the attached conversation's directory rather than the original launch directory. OpenCode carries the current prompt's agent/model into that new-session screen; its native model picker reads the inherited location. `npm run agents` supplies this setting by default.

Verify discovery with `opencode2 plugin list`: the package should appear. Named npm packages use the `./tui`/`.` exports.

For a project-scoped installation, the same object can go in `opencode.json(c)` under **`plugins`**, using `"$schema": "https://opencode.ai/config.json"`. The package exports a minimal server entrypoint alongside `./tui`, so OpenCode discovers its terminal component. There is no project-local `cli.json` in V2.

This targets **OpenCode V2.0.20+**, not the V1 `@opencode-ai/plugin` API. Check `opencode --version`; installations with both versions may expose V2 as `opencode2`.

Keyboard bindings register inside the mounted app contribution so they also work on V2.0.20–2.0.25, whose plugin setup runs outside `Keymap.Provider`. Startup, Escape/Ctrl+G re-entry, and Ctrl+C exit have been smoke-tested against V2.0.20, V2.0.25, and V2.0.26. If an older plugin release reports `Keymap.Provider is missing`, use an updated release containing this fix or a built local checkout.

## Try it from a local checkout

```sh
git clone https://github.com/Eamo5/opencode-agents-view.git
cd opencode-agents-view
npm install
npm run agents
```

On PowerShell, use `npm.cmd` if your execution policy blocks npm's `.ps1` shim. `npm run agents` builds the plugin and launches the development dependency, **OpenCode V2.0.26**, with the local plugin enabled for that invocation. Pass OpenCode arguments with `npm run agents -- --server http://localhost:4096`, for example.

For persistent local installation, run `npm run build` and use the configuration above with `"package"` set to the absolute checkout path, such as `"C:/Users/Eamon/Projects/opencode-agents-view"`. Restart OpenCode after installation. Rebuild after source changes; restart if an unwatched local dependency remains loaded. Local directories use the root `tui.js`/`index.js` forwarding entrypoints.

The ordinary OpenCode V2 service owns execution. Leaving the dashboard or switching sessions keeps sessions running. A private `--standalone` server lasts only as long as its CLI process.

## Enter, attach and detach

- In a session, press **`←` on an empty prompt** to enter agents view with that session selected, including while the initial session inventory loads. Detaching restores a previously hidden row and does not interrupt the session. Left continues to edit a nonempty prompt; dialogs, forms, autocomplete and shell mode retain their own keys.
- Run **`/agents-view`**, **`/bg`** or **`/background`**, press **`Ctrl+G`**, or select **Open agents view** from the command palette. OpenCode's built-in `/agents` manages agent definitions.
- With **`defaultToAgentsView: true`**, starting OpenCode normally opens the dashboard. Explicit `--prompt`, `--session` and `--continue` launches keep their normal startup behavior.
- The command-palette action **Toggle: open agents view by default** persists a user preference. That preference takes precedence over the plugin's configuration option.
- **`Enter` or `→`** attaches to the selected conversation. **`←`** on its empty prompt returns to the table.
- **`Esc`** clears the dashboard input, closes peek, then returns to the originating session or home screen. This also works when agents view was opened from home.

For an explicit shell launch after installing the plugin:

```sh
OPENCODE_AGENTS_VIEW=1 opencode2
```

```powershell
$env:OPENCODE_AGENTS_VIEW = '1'
opencode2
Remove-Item Env:\OPENCODE_AGENTS_VIEW
```

V2 terminal plugins register routes and slash commands, but cannot add a top-level `opencode agents` CLI subcommand. The environment flag and `npm run agents` supply explicit shell entry.

## Dispatch and monitor

Type a task and press **Enter** to create an independent root session in the selected folder. Selecting a conversation targets its folder in either grouping mode; without a selection, tasks use the launch folder. The dispatch input shows the target path. Every submission starts a new session. **Ctrl+Enter** dispatches and immediately attaches in terminals that report extended keys. **Tab** selects a dispatch agent; **Alt+M** selects a model. Opening the view from a conversation inherits that session's agent/model for dispatch. New tasks use OpenCode's configured permissions.

The default layout is a compact folder-first list, with colored status labels and muted output summaries. With an empty prompt, **Up/Down selects sessions and folder headings**. Selection also follows mouse hover. **Enter or click a folder heading to collapse/expand it**; Enter or click a session to open it. Collapsed sessions are skipped during navigation. Filters temporarily expand all folders. **Start typing a task**, then use **Up/Down to cycle its target folder**, wrapping at either end. While composing, hovering/clicking a folder heading or using **Ctrl+N** chooses the task's directory instead, including folders with only inactive, hidden, or archived sessions. Enter dispatches the task there. Clearing the task restores your session selection. **Alt+S** switches to state grouping. Previously used folders remain available without waking them during inventory refresh; if a folder has been deleted, attempting to start there reports an error and keeps your draft.

**Ctrl+S** switches the agents panel between folders and status groups: **Pinned, Needs action, Working, Completed**. Needs action includes input requests and idle sessions awaiting a prompt; Completed includes finished, failed, and stopped sessions. Grouping preserves your draft and shows all matching sessions. The header shows the current grouping and a compact OpenCode favicon-style O. **Ctrl+S inside a session still stashes its prompt.**

**Ctrl+Shift+S** stashes an agents-view draft or peek reply; **Ctrl+Alt+S** restores the latest stash, preserving any text it replaces. These text stashes last for the current OpenCode process and are separate from native session stashes. In session prompts, `prompt.stash` remains bound to `ctrl+s` and `prompt.stash.pop` to `ctrl+alt+s` in your installed `cli.json`. A session prompt containing only whitespace counts as empty for Left-arrow return (attachments still prevent detaching).

**Ctrl+C quits OpenCode** using its native exit command, including while composing a task or peeking. **Esc** clears the input, closes peek, then returns to the originating conversation. `/exit` and `/quit` also quit.

Pinned sessions appear once in a dedicated **Pinned** section above the folders. **Ctrl+T** unpins a session and returns it to its original folder. The launch folder and existing sessions share one folder layout. Equivalent Windows paths are merged regardless of slash direction, casing, or a trailing separator. Case-sensitive Unix paths stay distinct. This normalizes path spelling, not filesystem aliases such as symlinks.

Folders stay alphabetical below Pinned, and in the folder chooser and prompt cycling, regardless of the launch folder or recent activity. Within each folder and the Pinned section, sessions stay in creation order (oldest first). Messages and status changes update rows in place; new sessions append to their folder. State grouping still moves sessions between status groups, but does not reorder them by recent messages.

**Space** opens a peek panel with recent output. Type a reply and press Enter to queue it to that session; `/stop` interrupts it. Other `/commands` are delivered through OpenCode's command API. Pending permissions and forms display **Needs input**; attach with `→` to answer them through OpenCode's native UI. Reply drafts are kept separately for each selected session.

Rows show all non-archived root sessions on the connected server, including existing conversations. Subagents contribute running/attention state to their root instead of creating extra dashboard rows. Status comes from execution outcomes and pending requests. Recent output is fetched lazily, with bounded concurrency, and reused for row summaries without additional model calls. Visible working-session previews refresh on each successful inventory refresh, even when streaming output leaves the session timestamp unchanged; idle previews stay cached. Events trigger updates, with periodic refresh for reconnection recovery. The last successful list stays visible on a refresh failure.

### Session-local prompt history

By default, **Up/Down in a chat recalls only user prompts from that chat**, rather than OpenCode's shared history. Down past the newest entry restores your unsent draft. Multiline cursor movement, shell mode, and autocomplete keep their normal behavior. Recall restores text only, not prior attachments; drafts with attachments are left intact.

Set `"sessionOnlyHistory": false` in this plugin's `options` in `cli.json` to restore OpenCode's shared prompt history. Agents-panel Up/Down still navigates rows or task directories.

### Keyboard reference

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select sessions/folder headings when empty; cycle folders while composing a task |
| `PageUp` / `PageDown`, `Home` / `End` | Page or jump through rows |
| `Enter` | Dispatch a task, attach to a session, or send a peek reply |
| `→` | Attach to a session when input is empty or contains a filter |
| `Space` | Toggle peek on an empty input |
| `Shift+Enter` / `Ctrl+J` | Insert a newline |
| `Ctrl+Enter` | Dispatch and attach |
| `Ctrl+S` | Arrange agents by folder or status |
| `Ctrl+Shift+S` | Stash the current draft/reply |
| `Ctrl+Alt+S` | Restore the latest stashed draft/reply |
| `Alt+S` | Group by state or directory |
| `Ctrl+N` | Choose a target folder while composing a task, including inactive folders |
| `Ctrl+T` | Pin/unpin the selected session |
| `Ctrl+R` | Rename the selected session |
| `Ctrl+F` | Find sessions by name |
| `Ctrl+X` | Stop; press again within two seconds to hide the row |
| `Tab` / `Alt+M` | Choose dispatch agent/model |
| `Ctrl+L` | Refresh |
| `Esc` | Clear input, close peek, then return |
| `Ctrl+C` | Quit OpenCode directly through its native exit command |
| `?` | Show help |

Start the dispatch input with `n:name`, `a:agent`, `s:working`, `s:blocked`, or `o:output` to filter instead of dispatching. Combine filters, for example `s:blocked a:reviewer`. Output filters hydrate recent output from matching root-session inventory. Enter opens the selected match. Clearing the filter restores the full list.

Pins, grouping, hidden rows and the default-landing preference persist using plugin-scoped storage. **`/resume`** in the dispatch input, or **Restore hidden agents** in the palette, brings hidden rows back. Hiding preserves the conversation and its files; it does not delete the session transcript.

## Options

All options belong inside the plugin entry's `options` object.

| Option | Default | Meaning |
| --- | --- | --- |
| `defaultToAgentsView` | `false` | Open the dashboard on normal startup |
| `leftArrowOpensAgents` | `true` | Enable empty-prompt Left entry and the footer hint |
| `scope` | `"all"` | `"all"` server projects, or `"project"` including that project's worktrees |
| `refreshIntervalMs` | `5000` | Polling recovery interval; integer of at least `1000` |

## Implementation and verification

- `src/tui.tsx`: V2 registration, commands, footer contribution and startup entry.
- `src/view.tsx`: responsive full-screen table, dispatch input and peek panel.
- `src/controller.ts`: session API actions, events, refresh and durable preferences.
- `src/model.ts`: state precedence, grouping, summaries and filters.
- `scripts/build.mjs`: compiles Solid JSX to OpenTUI's universal renderer, producing JavaScript usable by both Bun and Node-based OpenCode distributions.

```sh
npm run check         # typecheck, behavioral tests, compile, V2 loader check
npm run test:native   # compiled UI + real OpenTUI rendering and keyboard events
npm pack --dry-run    # inspect publishable contents
```

Build/unit tests work on Node 22+. Native OpenTUI tests need **Node 26.4+**, with `--experimental-ffi` enabling the renderer and `--conditions=browser` selecting Solid's client runtime; the npm script includes both flags. They use a deterministic mock API and exercise default entry, delayed inventory, live summaries, attach/detach, hidden-row restoration, draft editing, fast task typing, dispatch, peek/reply, inactive-folder selection, deduplicated folder layouts, blank new sessions, Escape and terminal resizing.

If your default Node is older, run the native check from this checkout with:

```sh
npm exec --yes --package=node@26.4.0 -- node --experimental-ffi --conditions=browser scripts/test-native.mjs
```

### Port scope

The dashboard ports Claude's core multi-session workflow. OpenCode provides persistence and background execution. Tasks run in their selected directory; this plugin does not automatically create isolated worktrees. PR-review integration, background shell-job rows, voice input and Claude's supervisor-specific flags are outside this initial implementation.

Behavior references: [Claude agent view](https://code.claude.com/docs/en/agent-view), [OpenCode V2 CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli/), and the session/background infrastructure in [ultraworkers/claw-code](https://github.com/ultraworkers/claw-code). No source from the reference repository is vendored.

## License

Copyright (c) 2026 opencode-agents-view contributors.

Licensed under the GNU General Public License, version 2 only (`GPL-2.0-only`). See [LICENSE](LICENSE) for the full terms. This software is provided without warranty.
