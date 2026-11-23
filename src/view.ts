// Turns data into plain lines for the UI. No I/O, no JSX: tui.tsx only maps tones to colors.
import type { KbData, KbHealth, Snapshot } from "./model"
import type { KbActivity, SessionActivity } from "./session-activity"

export type Level = "ok" | "info" | "warn" | "error"
export type Tone = "text" | "muted" | "ok" | "warn" | "error" | "heading"

export interface Line {
  text: string
  tone?: Tone
  indent?: number
}

export interface Section {
  title: string
  lines: Line[]
}

export interface Issue {
  level: Level
  text: string
}

const RANK: Record<Level, number> = { ok: 0, info: 1, warn: 2, error: 3 }
export const worst = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b)

export function relTime(iso: string | number | undefined, now: number): string {
  if (iso === undefined || iso === "") return "—"
  const t = typeof iso === "number" ? iso : Date.parse(iso)
  if (!Number.isFinite(t)) return "—"
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export const trunc = (text: string, max: number) => (text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…")
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`

export function kbIssues(h: KbHealth | undefined): Issue[] {
  if (!h) return [{ level: "warn", text: "status unavailable" }]
  const issues: Issue[] = []
  if (h.pushLastError) issues.push({ level: "error", text: `push error: ${trunc(h.pushLastError, 80)}` })
  else if (h.pushState && h.pushState !== "clean") issues.push({ level: "warn", text: `push ${h.pushState}` })
  if (h.unpushed > 0) issues.push({ level: "warn", text: `${plural(h.unpushed, "commit")} not pushed` })
  if (h.behind > 0) issues.push({ level: "warn", text: `${plural(h.behind, "commit")} behind` })
  if (h.openContradictions > 0) issues.push({ level: "warn", text: `${plural(h.openContradictions, "open contradiction")}` })
  if (h.stale > 0) issues.push({ level: "warn", text: `${h.stale} stale` })
  if (h.lintFindings > 0) issues.push({ level: "warn", text: `${plural(h.lintFindings, "lint finding")}` })
  if (h.conformanceFindings > 0 && h.lintFindings === 0) issues.push({ level: "warn", text: `${plural(h.conformanceFindings, "conformance finding")}` })
  if (h.doctorSuggested) issues.push({ level: "info", text: "doctor session suggested" })
  if (h.latestVersion && h.serverVersion && h.latestVersion !== h.serverVersion) {
    issues.push({ level: "info", text: `update available: ${h.latestVersion} (installed ${h.serverVersion})` })
  }
  return issues
}

export const issuesLevel = (issues: Issue[]): Level => issues.reduce<Level>((l, i) => worst(l, i.level), "ok")

export interface Overall {
  level: Level
  issues: Issue[]
}

/** Problems that matter at a glance: connection, sync, binding, then per KB. */
export function overall(snap: Snapshot | undefined, activity?: SessionActivity): Overall {
  const issues: Issue[] = []
  if (!snap) return { level: "info", issues: [{ level: "info", text: "loading…" }] }
  if (snap.error) {
    const level: Level = snap.error.reason === "schema" && snap.status ? "warn" : "error"
    issues.push({ level, text: snap.error.message })
    if (!snap.status || snap.error.reason !== "schema") return { level, issues }
  }
  const state = snap.status?.provider?.state
  if (snap.status && !snap.status.provider) issues.push({ level: "warn", text: "opencode is not connected to Cartographer" })
  else if (state && state !== "in_sync") issues.push({ level: "warn", text: `sync state: ${state}` })
  if (snap.resolution?.scope === "none") issues.push({ level: "warn", text: "folder under no workspace binding: read-only, no KB" })
  for (const instruction of snap.instructions) {
    if (instruction.over) issues.push({ level: "warn", text: `instructions over threshold (${instruction.tokens}/${instruction.threshold} tokens)` })
  }
  for (const data of Object.values(snap.kbs)) {
    for (const issue of kbIssues(data.health)) issues.push({ ...issue, text: `${data.kb}: ${issue.text}` })
    if (data.errors.length && !data.health) issues.push({ level: "warn", text: `${data.kb}: ${data.errors[0]}` })
  }
  if (activity?.needsLog) {
    const names = activity.byKb.filter((k) => k.needsLog).map((k) => k.kb).join(", ")
    issues.push({ level: "info", text: `writes without log_append: ${names}` })
  }
  return { level: issuesLevel(issues), issues }
}

export function badge(snap: Snapshot | undefined, activity: SessionActivity | undefined, loading: boolean): { text: string; level: Level } {
  if (!snap) return { text: loading ? "KB …" : "KB —", level: "info" }
  if (snap.error && !snap.status) return { text: "KB —", level: "error" }
  const { level } = overall(snap, activity)
  const count = snap.resolution?.kbs.length ?? 0
  const mark = level === "ok" ? "✓" : level === "info" ? "ℹ" : level === "warn" ? "⚠" : "✗"
  if (snap.resolution?.scope === "none") return { text: `KB 0 ${mark}`, level }
  return { text: `KB ${count} ${mark}`, level }
}

const toneOf = (level: Level): Tone => (level === "ok" ? "ok" : level === "info" ? "muted" : level)

function counts(record: Record<string, number>, limit = 4): string {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, n]) => `${n} ${k}`)
    .join(" · ")
}

/** Compact per-KB lines for the sidebar. */
export function sidebarLines(snap: Snapshot | undefined, activity: SessionActivity | undefined, now: number, withHeading = true): Line[] {
  const lines: Line[] = withHeading ? [{ text: "Cartographer", tone: "heading" }] : []
  if (!snap) return [...lines, { text: "loading…", tone: "muted" }]
  if (snap.error && !snap.status) return [...lines, { text: trunc(snap.error.message, 40), tone: "error" }]
  if (snap.resolution?.scope === "none") lines.push({ text: "no KB bound (read-only)", tone: "warn" })
  for (const data of Object.values(snap.kbs)) {
    const issues = kbIssues(data.health)
    const level = issuesLevel(issues)
    const h = data.health
    lines.push({ text: `${level === "ok" ? "✓" : level === "info" ? "ℹ" : level === "warn" ? "⚠" : "✗"} ${data.kb}`, tone: toneOf(level) })
    if (h) {
      const git = h.hasRemote ? ` · ${h.pushState ?? "?"}${h.unpushed ? ` ↑${h.unpushed}` : ""}${h.behind ? ` ↓${h.behind}` : ""}` : ""
      lines.push({ text: `${h.total} concepts · ${h.openConcepts} open${git}`, tone: "muted", indent: 2 })
    } else lines.push({ text: trunc(data.errors[0] ?? "unavailable", 38), tone: "warn", indent: 2 })
  }
  const sync = snap.status?.provider?.state
  if (sync) lines.push({ text: `sync ${sync}`, tone: sync === "in_sync" ? "muted" : "warn" })
  const mine = activity?.byKb.filter((k) => k.reads.length + k.writes.length + k.searches + k.otherReads + k.otherWrites > 0) ?? []
  if (mine.length) {
    lines.push({ text: "this session", tone: "heading" })
    for (const k of mine) {
      lines.push({ text: `${k.kb}: ${k.reads.length + k.otherReads}r ${k.writes.length + k.otherWrites}w${k.needsLog ? " · no log" : ""}`, tone: k.needsLog ? "warn" : "muted", indent: 2 })
    }
  }
  void now
  return lines
}

function activityLines(k: KbActivity, now: number): Line[] {
  const lines: Line[] = [{ text: `${k.kb} · last ${relTime(k.lastAt, now)}`, tone: "text" }]
  const list = (title: string, items: Array<{ id: string; count: number }>) => {
    if (!items.length) return
    lines.push({ text: `${title} (${items.length})`, tone: "muted", indent: 2 })
    for (const item of items.slice(0, 8)) lines.push({ text: `${trunc(item.id, 56)}${item.count > 1 ? ` ×${item.count}` : ""}`, indent: 4 })
    if (items.length > 8) lines.push({ text: `… ${items.length - 8} more`, tone: "muted", indent: 4 })
  }
  list("read", k.reads)
  list("written", k.writes)
  const extras: string[] = []
  if (k.searches) extras.push(`${plural(k.searches, "search", "searches")}`)
  if (k.otherReads) extras.push(`${k.otherReads} other reads`)
  if (k.otherWrites) extras.push(`${k.otherWrites} other writes`)
  if (k.logAppends) extras.push(`${plural(k.logAppends, "log entry", "log entries")}`)
  if (k.unclassified) extras.push(`${k.unclassified} unclassified`)
  if (k.failed) extras.push(`${k.failed} failed`)
  if (extras.length) lines.push({ text: extras.join(" · "), tone: "muted", indent: 2 })
  if (k.needsLog) lines.push({ text: "writes without a following log_append", tone: "warn", indent: 2 })
  return lines
}

function kbLines(data: KbData, now: number): Line[] {
  const h = data.health
  const lines: Line[] = []
  const issues = kbIssues(h)
  lines.push({ text: `${data.kb}${h ? ` · ${h.total} concepts` : ""}`, tone: issues.length ? toneOf(issuesLevel(issues)) : "ok" })
  if (h) {
    if (Object.keys(h.byType).length) lines.push({ text: `types: ${counts(h.byType)}`, tone: "muted", indent: 2 })
    if (Object.keys(h.byStatus).length) lines.push({ text: `status: ${counts(h.byStatus)}`, tone: "muted", indent: 2 })
    lines.push({
      text: `stale ${h.stale} · contradictions ${h.openContradictions} · lint ${h.lintFindings} · review ${h.reviewTotal}`,
      tone: "muted",
      indent: 2,
    })
    lines.push({ text: `work: ${h.openConcepts} open concepts · ${h.openItems} open items`, tone: "muted", indent: 2 })
    const git = [`branch ${h.branch ?? "?"}`, h.hasRemote ? `push ${h.pushState ?? "?"}` : "no remote"]
    if (h.unpushed) git.push(`${h.unpushed} unpushed`)
    if (h.behind) git.push(`${h.behind} behind`)
    lines.push({ text: `git: ${git.join(" · ")}`, tone: "muted", indent: 2 })
    lines.push({ text: `pushed ${relTime(h.lastPushAt, now)} · synced ${relTime(h.lastSyncInAt, now)}`, tone: "muted", indent: 2 })
    for (const issue of issues) lines.push({ text: `${issue.level === "info" ? "ℹ" : "⚠"} ${issue.text}`, tone: toneOf(issue.level), indent: 2 })
  }
  for (const error of data.errors) lines.push({ text: `error ${error}`, tone: "warn", indent: 2 })
  if (data.work?.entries.length) {
    lines.push({ text: "open work", tone: "muted", indent: 2 })
    for (const e of data.work.entries) lines.push({ text: `${e.status || "open"} · ${trunc(e.title, 50)}${e.stale ? " (stale)" : ""}`, indent: 4 })
  }
  if (data.changes?.concepts.length) {
    lines.push({ text: `changes since ${data.changes.since?.slice(0, 10) ?? "7d"} (${plural(data.changes.commitCount, "commit")})`, tone: "muted", indent: 2 })
    for (const c of data.changes.concepts.slice(0, 5)) {
      const who = c.authors.length ? ` · ${trunc(c.authors.join(", "), 18)}` : ""
      lines.push({ text: `${c.change} ${trunc(c.id, 34)} · ${relTime(c.at, now)}${who}`, indent: 4 })
    }
  }
  if (data.log?.length) {
    lines.push({ text: "log", tone: "muted", indent: 2 })
    for (const e of data.log) lines.push({ text: `${relTime(e.at, now)} · ${trunc(e.summary, 56)}`, indent: 4 })
  }
  return lines
}

/** Full panel: workspace, sync, context cost, each KB, this session. */
export function panelSections(snap: Snapshot | undefined, activity: SessionActivity | undefined, now: number): Section[] {
  const sections: Section[] = []
  if (!snap) return [{ title: "Cartographer", lines: [{ text: "loading…", tone: "muted" }] }]
  const ov = overall(snap, activity)
  sections.push({
    title: "Overview",
    lines: ov.issues.length
      ? ov.issues.map((i) => ({ text: `${i.level === "error" ? "✗" : i.level === "info" ? "ℹ" : "⚠"} ${i.text}`, tone: toneOf(i.level) }))
      : [{ text: "✓ everything looks fine", tone: "ok" }],
  })
  const ws: Line[] = [{ text: snap.dir }]
  const res = snap.resolution
  if (res?.scope === "workspace" && res.binding) ws.push({ text: `bound by ${res.binding.path} → ${res.kbs.join(", ") || "(no KB)"}`, tone: "muted" })
  else if (res?.scope === "global") ws.push({ text: `global binding → ${res.kbs.join(", ")}`, tone: "muted" })
  else if (res?.scope === "none") ws.push({ text: "no binding covers this folder: served read-only", tone: "warn" })
  if (snap.status?.provider?.bindingOrigin) ws.push({ text: `binding origin: ${snap.status.provider.bindingOrigin}`, tone: "muted" })
  sections.push({ title: "Workspace", lines: ws })
  const st = snap.status
  if (st) {
    const sync: Line[] = []
    sync.push({ text: `server ${st.serverVersion ?? "?"} · client ${st.clientVersion ?? "?"}${st.serverVersion !== st.clientVersion ? " (differ)" : ""}`, tone: st.serverVersion === st.clientVersion ? "muted" : "warn" })
    const p = st.provider
    if (p) {
      sync.push({ text: `opencode: ${p.state}${p.revision ? ` · rev ${p.revision.slice(0, 8)}` : ""}`, tone: p.state === "in_sync" ? "ok" : "warn" })
      if (p.kindStatus) sync.push({ text: p.kindStatus, tone: "muted" })
    }
    sync.push({ text: `mounted KBs: ${st.mounted.join(", ") || "none"}`, tone: "muted" })
    sections.push({ title: "Sync", lines: sync })
  }
  if (snap.instructions.length) {
    sections.push({
      title: "Context cost",
      lines: snap.instructions.map((i) => ({
        text: `${i.path} · ~${i.tokens} tokens of ${i.threshold}${i.over ? " (over)" : ""}`,
        tone: i.over ? ("warn" as Tone) : ("muted" as Tone),
      })),
    })
  }
  for (const data of Object.values(snap.kbs)) sections.push({ title: `KB ${data.kb}`, lines: kbLines(data, now) })
  const mine = activity?.byKb.filter((k) => k.lastAt > 0) ?? []
  const sessionLines: Line[] = mine.length ? mine.flatMap((k) => activityLines(k, now)) : [{ text: "no Cartographer calls yet", tone: "muted" }]
  if (activity?.historyError) sessionLines.push({ text: `full history unavailable (${trunc(activity.historyError, 60)}): counting recent messages only`, tone: "warn" })
  sections.push({ title: "This session", lines: sessionLines })
  sections.push({ title: "Updated", lines: [{ text: `${relTime(snap.at, now)}`, tone: "muted" }] })
  return sections
}

export function flatten(sections: Section[]): Line[] {
  return sections.flatMap((s) => [{ text: s.title, tone: "heading" as Tone }, ...s.lines, { text: "" }])
}
