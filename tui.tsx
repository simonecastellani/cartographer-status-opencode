import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, Show } from "solid-js"
import { createRunner } from "./src/cartographer"
import { createStore } from "./src/loader"
import type { Snapshot } from "./src/model"
import { extractCalls, summarize, type KbCall, type SessionActivity } from "./src/session-activity"
import { createTracker, type FetchPage } from "./src/session-tracker"
import { badge, flatten, kbIssues, overall, panelSections, sidebarLines, type Level, type Line, type Tone } from "./src/view"

const PANEL = "cartographer.status"

function toneColor(theme: any, tone: Tone | undefined): any {
  switch (tone) {
    case "muted":
      return theme.text.muted
    case "ok":
      return theme.text.feedback.success.base
    case "warn":
      return theme.text.feedback.warning.base
    case "error":
      return theme.text.feedback.error.base
    case "heading":
      return theme.text.action.primary.base
    default:
      return theme.text.base
  }
}

const levelTone = (level: Level): Tone => (level === "ok" ? "ok" : level === "info" ? "muted" : level)

function LineView(props: { line: Line }) {
  const context = usePlugin()
  return (
    <text fg={toneColor(context.theme, props.line.tone)}>
      {" ".repeat(props.line.indent ?? 0)}
      {props.line.text}
    </text>
  )
}

export default Plugin.define({
  id: "cartographer.status",
  setup(context) {
    const options = (context.options ?? {}) as Record<string, unknown>
    const namespaces = Array.isArray(options.namespaces) ? (options.namespaces as string[]) : ["cartographer"]
    const ttlMs = Math.max(5, Number(options.ttlSeconds) || 30) * 1000
    const pollMs = Math.max(30, Number(options.pollSeconds) || 120) * 1000
    const run = createRunner({
      bin: typeof options.bin === "string" ? options.bin : undefined,
      provider: typeof options.provider === "string" ? options.provider : "opencode",
    })

    const [snap, setSnap] = createSignal<Snapshot | undefined>(undefined)
    const [loading, setLoading] = createSignal(false)
    const [tick, setTick] = createSignal(0)
    const shown = new Set<string>()
    const store = createStore({
      run,
      ttlMs,
      onChange: (snapshot, isLoading) => {
        setSnap(snapshot)
        setLoading(isLoading)
        if (!isLoading && snapshot) notify(snapshot)
      },
    })

    const defaultDir = () => context.location?.directory ?? context.data.location.default()?.directory
    const sessionDir = (sessionID?: string) =>
      (sessionID ? (context.data.session.get(sessionID) as any)?.location?.directory : undefined) ?? defaultDir()

    const fetchPage: FetchPage = async (query) => {
      const client: any = context.client
      const list = client.message?.list ?? client.session?.message?.list
      if (typeof list !== "function") throw new Error("message list is not available in this client")
      const res: any = await list.call(client.message ?? client.session.message, { ...query })
      const body = res?.data ?? res
      return { data: Array.isArray(body) ? body : (body?.data ?? []), next: body?.cursor?.next ?? null }
    }
    const tracker = createTracker({ fetchPage, namespaces, onChange: () => setTick((n) => n + 1) })

    function activityFor(sessionID?: string): SessionActivity | undefined {
      tick()
      if (!sessionID) return undefined
      try {
        const ids: string[] = context.data.session.family(sessionID) ?? [sessionID]
        for (const id of ids) void tracker.ensure(id)
        // The TUI keeps a window of recent messages; the tracker holds the full history. Merge by call id.
        const byId = new Map<string, KbCall>()
        for (const id of ids) {
          const window = (context.data.session.message.list(id) as unknown[] | undefined) ?? []
          for (const call of extractCalls(window, { namespaces })) byId.set(`${id}|${call.callID}`, call)
        }
        for (const call of tracker.calls(ids)) byId.set(`${call.sessionID}|${call.callID}`, call)
        const only = snap()?.resolution?.kbs.length === 1 ? snap()!.resolution!.kbs[0] : undefined
        const result = summarize([...byId.values()], only)
        const historyError = tracker.lastError(ids)
        return historyError ? { ...result, historyError } : result
      } catch {
        return undefined
      }
    }

    function notify(snapshot: Snapshot) {
      const { issues } = overall(snapshot)
      for (const issue of issues) {
        if (issue.level === "ok" || issue.level === "info") continue
        const key = `${snapshot.dir}|${issue.text}`
        if (shown.has(key)) continue
        shown.add(key)
        context.ui.toast.show({ title: "Cartographer", message: issue.text, variant: issue.level === "error" ? "error" : "warning", duration: 6000 })
      }
    }

    const refresh = (dir: string | undefined, force = false) => {
      if (!dir) return Promise.resolve(undefined)
      return store.refresh(dir, { force }).catch(() => undefined)
    }

    // --- data: initial load, polling and session events
    void refresh(defaultDir())
    const timer = setInterval(() => void refresh(snap()?.dir ?? defaultDir()), pollMs)
    const logReminded = new Set<string>()
    const familyOf = (sessionID: string): string[] => {
      try {
        return context.data.session.family(sessionID) ?? [sessionID]
      } catch {
        return [sessionID]
      }
    }
    const pending = new Map<string, ReturnType<typeof setTimeout>>()
    const onTool = (event: any) => {
      const sessionID: string | undefined = event?.data?.sessionID
      if (!sessionID) return
      setTick((n) => n + 1)
      if (pending.has(sessionID)) return
      pending.set(
        sessionID,
        setTimeout(() => {
          pending.delete(sessionID)
          void tracker.refreshLatest(sessionID)
        }, 1500),
      )
    }
    const onEnd = async (event: any) => {
      const sessionID: string | undefined = event?.data?.sessionID
      if (!sessionID) return
      await Promise.all(familyOf(sessionID).map((id) => tracker.refreshLatest(id)))
      void refresh(sessionDir(sessionID))
      const a = activityFor(sessionID)
      for (const k of a?.byKb ?? []) {
        const key = `${sessionID}|${k.kb}|${k.lastAt}`
        if (k.needsLog && !logReminded.has(key)) {
          logReminded.add(key)
          context.ui.toast.show({ title: "Cartographer", message: `${k.kb}: pages written without a log_append`, variant: "warning", duration: 6000 })
        }
      }
    }
    const stops = [
      context.data.on("session.tool.success", onTool),
      context.data.on("session.tool.failed", onTool),
      context.data.on("session.execution.succeeded", onEnd),
      context.data.on("session.execution.failed", onEnd),
      context.data.on("session.execution.interrupted", onEnd),
    ]

    // --- views
    function Badge(props: { sessionID?: string }) {
      const plugin = usePlugin()
      const b = createMemo(() => badge(snap(), activityFor(props.sessionID), loading()))
      return <text fg={toneColor(plugin.theme, levelTone(b().level))}>{b().text}</text>
    }

    function Lines(props: { lines: () => Line[] }) {
      // A reactive array child crashes the renderer on update; keyed Show rebuilds a static subtree instead.
      const current = createMemo(() => props.lines())
      return (
        <Show when={current()} keyed>
          {(lines) => <box flexDirection="column">{lines.map((line) => <LineView line={line} />)}</box>}
        </Show>
      )
    }

    // Folded state is persisted like the host's own MCP section.
    const [sidebarState, updateSidebar] = context.storage.store("sidebar", { initial: { open: true } })
    const sidebarOpen = (): boolean => {
      const state: any = typeof sidebarState === "function" ? (sidebarState as any)() : sidebarState
      return state?.open !== false
    }
    const toggleSidebar = () => {
      try {
        void Promise.resolve(updateSidebar((draft: any) => void (draft.open = !draft.open))).catch(() => {})
      } catch {}
    }

    function Sidebar(props: { sessionID?: string }) {
      const plugin = usePlugin()
      const summary = createMemo(() => badge(snap(), activityFor(props.sessionID), loading()))
      return (
        <box flexDirection="column">
          <box flexDirection="row" gap={1} onMouseDown={toggleSidebar}>
            <text>{sidebarOpen() ? "▼" : "▶"}</text>
            <text>
              <b>Cartographer</b>
            </text>
            <Show when={!sidebarOpen()}>
              <text fg={toneColor(plugin.theme, levelTone(summary().level))}>{summary().text}</text>
            </Show>
          </box>
          <Show when={sidebarOpen()}>
            <Lines lines={() => sidebarLines(snap(), activityFor(props.sessionID), Date.now(), false)} />
          </Show>
        </box>
      )
    }

    function Panel(props: { panel: any }) {
      const lines = createMemo(() => flatten(panelSections(snap(), activityFor(props.panel.sessionID), Date.now())))
      let box: any
      const scroll = (rows: number) => () => {
        try {
          box?.scrollBy?.(rows)
        } catch {}
      }
      // Active only while the panel owns input.
      context.keymap.layer(() => ({
        commands: [
          { id: "cartographer.status.panel.close", title: "Cartographer: close panel", bind: "escape", run: () => props.panel.close() },
          { id: "cartographer.status.panel.down", bind: "down", run: scroll(3) },
          { id: "cartographer.status.panel.up", bind: "up", run: scroll(-3) },
          { id: "cartographer.status.panel.pagedown", bind: "pagedown", run: scroll(15) },
          { id: "cartographer.status.panel.pageup", bind: "pageup", run: scroll(-15) },
        ],
      }))
      return (
        <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
          <scrollbox flexGrow={1} ref={(el: any) => (box = el)}>
            <text fg={context.theme.text.muted}>esc to close · /kb-status refresh to reload</text>
            <Lines lines={lines} />
            <Show when={loading()}>
              <text fg={context.theme.text.muted}>refreshing…</text>
            </Show>
          </scrollbox>
        </box>
      )
    }

    const unregister: Array<() => void> = []
    const add = (r: unknown) => {
      if (typeof r === "function") unregister.push(r as () => void)
    }
    add(context.ui.slot({ append: "home.footer.status", render: () => <Badge /> }))
    add(context.ui.slot({ append: "prompt.footer.status", render: (input: any) => <Badge sessionID={input?.sessionID} /> }))
    add(context.ui.slot({ append: "sidebar.content", render: (input: any) => <Sidebar sessionID={input?.sessionID} /> }))
    add(
      context.ui.slot({
        append: "session.panel",
        render: (panel: any) => (
          <Show when={panel.name === PANEL}>
            <Panel panel={panel} />
          </Show>
        ),
      }),
    )

    // --- commands (all of them only read or refresh the plugin's own view)
    async function showKb(kb: string) {
      const data = snap()?.kbs[kb]
      if (!data) return
      const plain = panelSections({ ...snap()!, kbs: { [kb]: data } }, undefined, Date.now()).find((s) => s.title === `KB ${kb}`)
      const url = data.health?.uiUrl
      const text = [...(plain?.lines ?? []).map((l) => `${" ".repeat(l.indent ?? 0)}${l.text}`), ...(url ? ["", `Atlas: ${url}`] : [])].join("\n")
      context.ui.dialog.set({ size: "large" })
      await context.ui.dialog.alert({ title: `Cartographer · ${kb}`, message: text })
    }

    async function pickKb() {
      const s = snap()
      if (!s) return void context.ui.toast.show({ message: "Cartographer data is still loading", variant: "info" })
      const kbs = Object.values(s.kbs)
      if (kbs.length === 0) return void context.ui.dialog.alert({ title: "Cartographer", message: flatten(panelSections(s, undefined, Date.now())).slice(0, 12).map((l) => l.text).join("\n") })
      const choice = await context.ui.dialog.select({
        title: "Cartographer · KBs of this workspace",
        options: kbs.map((d) => {
          const issues = kbIssues(d.health)
          return {
            title: d.kb,
            value: d.kb,
            description: d.health ? `${d.health.total} concepts${issues.length ? ` · ${issues.length} to look at` : ""}` : "unavailable",
          }
        }),
      })
      if (choice) await showKb(choice as string)
    }

    function panelIsOpen(): boolean {
      try {
        const current: any = context.ui.panel.current()
        return current === PANEL || current?.name === PANEL
      } catch {
        return false
      }
    }

    async function command(input?: string) {
      const arg = (input ?? "").trim()
      if (arg === "close") {
        context.ui.panel.close()
        return
      }
      if (arg === "refresh") {
        context.ui.toast.show({ message: "Refreshing Cartographer…", variant: "info", duration: 1500 })
        await refresh(snap()?.dir ?? defaultDir(), true)
        return
      }
      if (arg && snap()?.kbs[arg]) return showKb(arg)
      if (panelIsOpen()) return void context.ui.panel.close()
      if (context.ui.panel.open(PANEL) === false) await pickKb()
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        { id: "cartographer.status.open", title: "Cartographer: status panel", group: "Cartographer", palette: true, slash: { name: "kb-status", arguments: true }, run: (input?: string) => command(input) },
        { id: "cartographer.status.kbs", title: "Cartographer: KBs of this workspace", group: "Cartographer", palette: true, run: () => pickKb() },
        { id: "cartographer.status.sidebar.toggle", title: "Cartographer: fold/unfold sidebar summary", group: "Cartographer", palette: true, run: () => toggleSidebar() },
        { id: "cartographer.status.close", title: "Cartographer: close panel", group: "Cartographer", palette: true, run: () => command("close") },
        { id: "cartographer.status.refresh", title: "Cartographer: refresh", group: "Cartographer", palette: true, run: () => command("refresh") },
      ],
    }))

    return () => {
      clearInterval(timer)
      for (const t of pending.values()) clearTimeout(t)
      for (const stop of stops) {
        try {
          stop()
        } catch {}
      }
      for (const off of unregister) {
        try {
          off()
        } catch {}
      }
    }
  },
})
