// Pure parsing and normalization of Cartographer output. No I/O.

export const STATUS_SCHEMA = "cartographer.status/v1"

export interface InstructionsBlock {
  path: string
  bytes: number
  tokens: number
  threshold: number
  over: boolean
}

export interface WorkspaceBinding {
  path: string
  kbs: string[]
  state: string
}

export interface ProviderStatus {
  state: string
  revision?: string
  boundKbs: string[]
  bindingOrigin?: string
  kindStatus?: string
  workspaces: WorkspaceBinding[]
  instructions: InstructionsBlock[]
}

export interface StatusInfo {
  schemaOk: boolean
  schemaVersion: string
  reachable: boolean
  ready: boolean
  clientVersion?: string
  serverVersion?: string
  mounted: string[]
  provider?: ProviderStatus
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as any) : {})
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : [])
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d)
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string")

export function parseStatus(raw: string, provider = "opencode"): StatusInfo {
  const data = obj(JSON.parse(raw))
  const schemaVersion = str(data.schema_version) ?? ""
  const entry = arr(data.providers).map(obj).find((p) => p.name === provider)
  let providerStatus: ProviderStatus | undefined
  if (entry) {
    providerStatus = {
      state: str(entry.state) ?? "unknown",
      revision: str(entry.revision),
      boundKbs: strs(entry.bound_kbs),
      bindingOrigin: str(entry.binding_origin),
      kindStatus: str(entry.kind_status),
      workspaces: arr(entry.workspaces)
        .map(obj)
        .filter((w) => typeof w.path === "string")
        .map((w) => ({ path: w.path as string, kbs: strs(w.kbs), state: str(w.state) ?? "unknown" })),
      instructions: arr(entry.instructions_blocks)
        .map(obj)
        .filter((b) => typeof b.path === "string")
        .map((b) => ({
          path: b.path as string,
          bytes: num(b.bytes),
          tokens: num(b.approx_tokens),
          threshold: num(b.threshold),
          over: b.over === true,
        })),
    }
  }
  return {
    schemaOk: schemaVersion === STATUS_SCHEMA,
    schemaVersion,
    reachable: data.reachable === true,
    ready: data.ready === true,
    clientVersion: str(data.client_version),
    serverVersion: str(data.server_version),
    mounted: strs(data.kbs),
    provider: providerStatus,
  }
}

export interface WorkspaceResolution {
  scope: "workspace" | "global" | "none"
  /** the binding that covers the folder (workspace scope) */
  binding?: WorkspaceBinding
  kbs: string[]
}

const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p)
const covers = (root: string, dir: string) => {
  const r = norm(root)
  const d = norm(dir)
  return d === r || r === "/" || d.startsWith(r + "/")
}

/** Longest-prefix binding for a folder; folders under no binding are served read-only with no KB. */
export function resolveWorkspace(dir: string, provider: ProviderStatus | undefined): WorkspaceResolution {
  if (!provider) return { scope: "none", kbs: [] }
  const hits = provider.workspaces.filter((w) => covers(w.path, dir)).sort((a, b) => norm(b.path).length - norm(a.path).length)
  if (hits[0]) return { scope: "workspace", binding: hits[0], kbs: hits[0].kbs }
  if (provider.workspaces.length === 0 && provider.boundKbs.length > 0) return { scope: "global", kbs: provider.boundKbs }
  return { scope: "none", kbs: [] }
}

/** Instructions blocks that apply to a folder: the AGENTS.md in the folder or in one of its ancestors. */
export function applicableInstructions(dir: string, blocks: InstructionsBlock[]): InstructionsBlock[] {
  return blocks.filter((b) => {
    const parent = b.path.replace(/\/[^/]*$/, "") || "/"
    return covers(parent, dir)
  })
}

/** `cartographer call --output json` wraps the tool result; return the text of its first content item. */
export function unwrapCall(raw: string): string {
  const data = obj(JSON.parse(raw))
  const first = obj(arr(data.content)[0])
  if (typeof first.text !== "string") throw new Error("unexpected tool result shape")
  return first.text
}

export interface KbHealth {
  kb: string
  total: number
  byType: Record<string, number>
  byStatus: Record<string, number>
  stale: number
  openContradictions: number
  lintFindings: number
  conformanceFindings: number
  doctorSuggested: boolean
  reviewTotal: number
  reviewByKind: Record<string, number>
  openConcepts: number
  openItems: number
  branch?: string
  pushState?: string
  pushLastError?: string
  hasRemote: boolean
  unpushed: number
  behind: number
  lastPushAt?: string
  lastSyncInAt?: string
  uiUrl?: string
  serverVersion?: string
  latestVersion?: string
}

const counts = (v: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries(obj(v)).filter(([, n]) => typeof n === "number")) as Record<string, number>

/** Normalizes kb_status. Deliberately drops remote_url (internal host names). */
export function parseKbStatus(kb: string, text: string): KbHealth {
  const d = obj(JSON.parse(text))
  const conformance = obj(d.conformance)
  const review = obj(d.review)
  const work = obj(d.work)
  return {
    kb,
    total: num(d.total),
    byType: counts(d.by_type),
    byStatus: counts(d.by_status),
    stale: num(d.stale_count),
    openContradictions: num(d.open_contradictions),
    lintFindings: num(conformance.lint_findings),
    conformanceFindings: num(conformance.findings),
    doctorSuggested: conformance.doctor_suggested === true,
    reviewTotal: num(review.total),
    reviewByKind: counts(review.by_kind),
    openConcepts: num(work.open_concepts),
    openItems: num(work.open_items),
    branch: str(d.branch),
    pushState: str(d.push_state),
    pushLastError: str(d.push_last_error),
    hasRemote: d.has_remote === true,
    unpushed: num(d.unpushed_commits),
    behind: num(d.behind_commits),
    lastPushAt: str(d.last_push_at),
    lastSyncInAt: str(d.last_sync_in_at),
    uiUrl: str(d.ui_url),
    serverVersion: str(d.server_version),
    latestVersion: str(d.latest_version),
  }
}

export interface WorkEntry {
  id: string
  title: string
  status: string
  stale: boolean
}

export interface WorkInfo {
  total: number
  byStatus: Record<string, number>
  entries: WorkEntry[]
}

export function parseWorkList(text: string): WorkInfo {
  const d = obj(JSON.parse(text))
  return {
    total: num(d.total),
    byStatus: counts(d.by_status),
    entries: arr(d.entries)
      .map(obj)
      .filter((e) => typeof e.id === "string")
      .map((e) => ({ id: e.id, title: str(e.title) ?? e.id, status: str(e.status) ?? "", stale: e.stale === true })),
  }
}

export interface ChangeEntry {
  id: string
  change: string
  at: string
  authors: string[]
  reason?: string
}

export interface ChangesInfo {
  since?: string
  commitCount: number
  concepts: ChangeEntry[]
}

export function parseChanges(text: string): ChangesInfo {
  const d = obj(JSON.parse(text))
  return {
    since: str(d.since),
    commitCount: num(d.commit_count),
    concepts: arr(d.concepts)
      .map(obj)
      .filter((c) => typeof c.id === "string")
      .map((c) => ({
        id: c.id,
        change: str(c.change) ?? "modified",
        at: str(c.last_at) ?? "",
        authors: strs(c.authors),
        reason: strs(c.reasons)[0],
      })),
  }
}

export interface LogEntry {
  at: string
  summary: string
}

/** log_tail returns markdown: `## <timestamp>` headings followed by the entry text. */
export function parseLogTail(text: string): LogEntry[] {
  const entries: LogEntry[] = []
  let current: { at: string; lines: string[] } | undefined
  const flush = () => {
    if (!current) return
    const lines = current.lines.map((l) => l.trim()).filter(Boolean)
    const head = lines[0] ?? ""
    const first = lines.find((l) => l.startsWith("- "))
    const summary = first ? `${head.replace(/:$/, "").replace(/\s*\(\d+ operation\(s\)\)/, "")} · ${first.slice(2)}` : head
    entries.push({ at: current.at, summary })
  }
  for (const line of text.split("\n")) {
    const m = /^##\s+(\S+)\s*$/.exec(line)
    if (m) {
      flush()
      current = { at: m[1]!, lines: [] }
    } else current?.lines.push(line)
  }
  flush()
  return entries
}

export interface KbData {
  kb: string
  health?: KbHealth
  work?: WorkInfo
  changes?: ChangesInfo
  log?: LogEntry[]
  /** per-section failures; a failing section never hides the others */
  errors: string[]
  fetchedAt: number
}

export interface Snapshot {
  dir: string
  at: number
  status?: StatusInfo
  resolution?: WorkspaceResolution
  instructions: InstructionsBlock[]
  kbs: Record<string, KbData>
  /** set when nothing could be read at all */
  error?: { reason: "not-installed" | "unreachable" | "schema" | "failed"; message: string }
}
