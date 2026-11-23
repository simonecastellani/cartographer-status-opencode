# cartographer-status

A **read-only** OpenCode TUI plugin that shows the [Cartographer](https://github.com/BeppeTemp/cartographer)
knowledge bases (KBs) bound to the current workspace, their health, and how the current session
uses them.

It never writes to a KB. See [Read-only guarantees](#read-only-guarantees).

- OpenCode: V2 (tested on 2.4.1), TUI plugin (`@opencode/plugin/tui`)
- Cartographer: tested on v0.29.1 (`cartographer.status/v1`)

## What it shows

| Where | What |
|---|---|
| Footer (`home.footer.status`, `prompt.footer.status`) | A compact badge such as `KB 3 ℹ`: number of KBs bound to the folder and the worst level among all findings. |
| Sidebar (`sidebar.content`) | A foldable "Cartographer" section, like the built-in MCP one: the KBs of the workspace with their state, plus a "this session" block. Click the header to fold it; folded, it keeps a one-line summary (`▶ Cartographer KB 3 ℹ`). |
| Panel (`session.panel`, `/kb-status`) | Full status: workspace, sync, context cost, every KB, session activity. |
| Toasts | One notification per new problem, and a reminder when a session wrote pages without a `log_append`. |

### Commands

| Command | Effect |
|---|---|
| `/kb-status` | Opens the panel inside a session; outside a session, lists the KBs. |
| `/kb-status <kb-name>` | Details of one KB in a dialog (concepts, git, open work, recent changes, log, Atlas URL). |
| `/kb-status refresh` | Reloads the data now, ignoring the cache. |
| `/kb-status close` | Closes the panel. |

The same actions are in the command palette under "Cartographer" (including "Cartographer: close panel" and "Cartographer: fold/unfold sidebar summary"). The folded state is remembered across restarts.

### Using the panel

While the panel is open it owns the keyboard (typing does not reach the prompt):

| Key | Effect |
|---|---|
| `esc` | Close the panel. |
| `↑` / `↓` | Scroll by 3 lines. |
| `PageUp` / `PageDown` | Scroll by 15 lines. |

Because the panel holds the keyboard, `/kb-status` cannot be typed while it is open: use `esc`, or
"Cartographer: close panel" from the palette (`ctrl+p`). When it is closed, `/kb-status` opens it again.

### Legend

Sidebar, one KB:

```
ℹ kb-shared
  85 concepts · 5 open · clean
```

- Icon: `✓` nothing to look at · `ℹ` informational (for example "doctor session suggested") ·
  `⚠` needs attention (unpushed or behind commits, stale pages, contradictions, lint findings) ·
  `✗` error (for example a push error).
- `concepts`: pages in the KB. `open`: concepts with open work (`open` or `in-progress`).
- Last word: the git push state (`clean` means aligned with the remote). Also shows `↑n` unpushed and `↓n` behind commits.

```
sync in_sync
```

State of the OpenCode client against Cartographer. Anything other than `in_sync` is flagged.

```
this session
  kb-shared: 14r 0w
```

What the agent did with each KB in this session (subagents included), from its tool calls:
`r` = reads, `w` = writes. The numbers count distinct concepts (or paths for artifacts), plus calls that name
no concept (searches, overviews). `no log` is added when there are writes with no later `log_append`.

The panel also lists the concepts read and written, searches, failed and unclassified calls.

## Requirements and install

- OpenCode 2.x with the Cartographer MCP server connected as `cartographer` (the default name).
- The `cartographer` binary, found in `PATH`, in `~/.local/bin`, or in the usual Homebrew locations.
  Set the `bin` option to use another path.

Copy or clone this folder to:

```
~/.config/opencode/plugins/cartographer-status/
```

OpenCode discovers plugins in that directory by itself (`tui.tsx` is the entry point); no change to
`opencode.json` or `cli.json` is needed. Use `/reload` to pick up edits.

### Options

Options are read from `context.options`. Pass them with the object form of a plugin entry, using the absolute path
of this folder as `package` (see [CLI plugins](https://opencode.ai/docs/cli/plugins/)):

```jsonc
{
  "plugins": [
    { "package": "/home/<you>/.config/opencode/plugins/cartographer-status", "options": { "pollSeconds": 300 } }
  ]
}
```

> Not verified yet: the defaults are what the plugin was tested with. Passing options for a plugin that is also
> discovered from the plugins directory has not been tried, so check that it does not load twice.

| Option | Default | Meaning |
|---|---|---|
| `bin` | auto-detected | Path of the `cartographer` binary. |
| `provider` | `opencode` | Cartographer provider name used for `workspace` and `call`. |
| `namespaces` | `["cartographer"]` | MCP server names that count as Cartographer. Any name containing "cartographer" also matches. |
| `ttlSeconds` | `30` | Cache lifetime of a snapshot (minimum 5). |
| `pollSeconds` | `120` | Background refresh period (minimum 30). |

## How it works

### Data

One snapshot per folder, loaded in parallel and cached:

1. `cartographer status --output json` gives the connection, versions, the `opencode` provider state, the
   workspace bindings and the size of the injected instructions.
2. The KBs of the folder come from the longest workspace binding that covers it. A folder under no binding
   has no KB and is served read-only by Cartographer.
3. For each KB, `cartographer call --provider opencode <tool> kb=<kb> --dir <folder> --output json` runs
   `kb_status`, `work_list`, `changes_since` (7 days) and `log_tail`. A failing section does not hide the others.

Refresh happens at start, when a session ends, every `pollSeconds`, and on `/kb-status refresh`.

### Session activity

The plugin reads the session's messages and extracts the calls to Cartographer; it does not call Cartographer for this.

- **Code Mode (OpenCode default):** the agent calls MCP tools through `execute`, and the calls are in
  `state.metadata.toolCalls` as `{ tool: "cartographer.<tool>", status, input }`.
- **Direct tools** (`codemode: false`): a tool call named `<server>_<tool>`.

The TUI keeps only a window of recent messages, so the full history is read once per session through the client
(`message.list`, assistant messages only) and later refreshed from the newest page. Subagent sessions are included.
If that fails, the panel says so and counts only the recent messages. A failed load is not retried for 30 seconds.

Only the KB name, the tool name and the concept ids are kept. Bodies, edits and frontmatter are never stored.

Tools are classified as read, write or unclassified from a static table; a tool that is not in it is reported as
"unclassified" and counts as neither.

## Read-only guarantees

- `src/cartographer.ts` is the only module that starts a process. It accepts a closed set of requests: `status`,
  `workspace list` and the tools `kb_status`, `work_list`, `changes_since`, `log_tail`, with a per-tool list of
  allowed arguments. Anything else is rejected before a process is spawned.
- Tests fail if a write tool (`concept_write`, `log_append`, `artifact_write`, `snapshot`, …) is requested, if
  another module spawns a process, if the plugin uses file-writing APIs, or if it touches the network.
- The plugin does not write files. Its state lives in memory.

One thing to be aware of: Cartographer keeps its own usage statistics (for example `read_access` in `kb_status`) and an
audit log. Querying a KB through `cartographer call` may leave a consultation trace there. This has not been measured.
The KB content and its git history are not changed.

## Layout

```
tui.tsx                  plugin entry: setup, slots, commands, toasts, events
src/cartographer.ts      the only process spawner; allowlist; binary lookup
src/loader.ts            snapshot loading and the TTL cache
src/model.ts             parsing and normalization of Cartographer output
src/session-activity.ts  extraction and summary of Cartographer calls from messages
src/session-tracker.ts   per-session message history, paging and refresh
src/view.ts              plain lines for the badge, sidebar, panel and dialogs
test/                    bun tests, with fixtures built from real output
```

`view.ts` and everything under `src/` is free of JSX and of OpenCode imports, so it is tested without a TUI.

## Development

```sh
bun test
```

To try the plugin without touching your shared service, run a throwaway TUI with its own server:

```sh
cd <some workspace> && opencode --standalone -s <session-id>
```

Things learned while building it:

- A reactive array child inside a slot crashed the renderer on update. Lines are rebuilt through a keyed `Show`
  instead of `For` or `.map` in a reactive position.
- Theme colors that are objects need a leaf: use `theme.text.action.primary.base`, not `…primary`.
  Available tokens used here: `text.base`, `text.muted`, `text.feedback.{success,warning,error}.base`.
- A panel is not bounded in height by the host: put its content in a `<scrollbox>` and bind scroll keys
  yourself in a keymap layer (`scrollBy`); the layer is active only while the panel owns input. Anything below the
  viewport, such as a footer hint, is not visible, so the hint is the first line of the scroll content.
- Do not retry a failed load from inside a reactive computation: it re-runs the computation and loops.
- `context.client.message.list` is the client entry for message pages; `session.message` only has `get`.
- The server hooks `ctx.tool.hook(...)` are not available to TUI plugins; the plugin relies on events
  (`session.tool.success|failed`, `session.execution.*`) and on message data instead.

## Known limits

- With a TUI connected to a **remote** OpenCode server, workspace paths do not match this machine's Cartographer
  bindings, so the data is not meaningful.
- The panel is taller than the terminal, so its content is in a scrollbox driven by the keys above (the mouse wheel is untested).
- The KB detail dialog is narrow and wraps long lines; the session panel is easier to read.
- The status format is `cartographer.status/v1`. A different schema is reported and shown as partial data.
