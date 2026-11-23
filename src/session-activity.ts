// Reads what the agent did with Cartographer from the session's messages. Pure: it never calls
// Cartographer and it never keeps concept bodies, only tool names, KB names and concept ids.

export const READ_TOOLS = new Set([
  "concept_read", "search", "graph_context", "graph_neighbors", "concept_list", "index_get", "atlas_overview",
  "map_list", "log_tail", "work_list", "kb_status", "changes_since", "source_list", "artifact_read", "asset_read",
  "asset_list", "concept_history", "link_suggest", "template_list", "service_get", "kb_guide", "kb_review",
  "lint", "validate", "conflicts_list",
])

export const WRITE_TOOLS = new Set([
  "concept_write", "concept_patch", "concept_batch", "concept_new", "concept_move", "concept_delete",
  "concept_expand", "supersede", "index_patch", "log_append", "artifact_write", "artifact_delete", "asset_write",
  "asset_delete", "snapshot", "map_create", "map_update", "map_delete", "source_register", "kb_repair",
  "secret_set", "git_conflict_resolve", "ingest_setup",
])

export type CallKind = "read" | "write" | "unclassified"

export interface KbCall {
  sessionID?: string
  messageID?: string
  callID: string
  kb?: string
  tool: string
  kind: CallKind
  status: "completed" | "error" | "running" | "other"
  ids: string[]
  query?: string
  at: number
  /** true when recovered by scanning the code of an `execute` call, without inputs */
  approx?: boolean
}

export interface ExtractOptions {
  /** MCP server names (already normalized) used by Cartographer; any name containing "cartographer" also matches. */
  namespaces?: string[]
}

const asObject = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as any) : {})

export function classify(tool: string): CallKind {
  if (WRITE_TOOLS.has(tool)) return "write"
  if (READ_TOOLS.has(tool)) return "read"
  return "unclassified"
}

const normalizeName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_")

function namespaceMatches(ns: string, opts: ExtractOptions): boolean {
  const lower = ns.toLowerCase()
  return lower.includes("cartographer") || (opts.namespaces ?? []).some((n) => normalizeName(n).toLowerCase() === lower)
}

/** Concept ids touched by a call; never bodies, edits or frontmatter. */
export function extractIds(input: Record<string, any>, tool = ""): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v === "string" && v) out.push(v)
  }
  push(input.id)
  if (/^(artifact|asset)_|^index_patch$/.test(tool)) push(input.path)
  push(input.source_id)
  push(input.target_id)
  for (const v of Array.isArray(input.ids) ? input.ids : []) push(v)
  for (const op of Array.isArray(input.operations) ? input.operations : []) push(asObject(op).id)
  for (const move of Array.isArray(input.moves) ? input.moves : []) {
    push(asObject(move).source_id)
    push(asObject(move).target_id)
  }
  return [...new Set(out)]
}

function makeCall(
  base: { sessionID?: string; messageID?: string; callID: string; at: number },
  tool: string,
  input: Record<string, any>,
  status: KbCall["status"],
  approx = false,
): KbCall {
  const query = typeof input.query === "string" ? input.query.slice(0, 120) : undefined
  return {
    ...base,
    kb: typeof input.kb === "string" ? input.kb : undefined,
    tool,
    kind: classify(tool),
    status,
    ids: extractIds(input, tool),
    query,
    ...(approx ? { approx: true } : {}),
  }
}

const toStatus = (s: unknown): KbCall["status"] =>
  s === "completed" || s === "error" || s === "running" ? s : "other"

/**
 * Cartographer calls in a list of messages. Handles both ways OpenCode records them:
 *  - Code Mode (default): one `execute` tool call; the MCP calls are in `state.metadata.toolCalls`
 *    as `{ tool: "<server>.<tool>", status, input }`.
 *  - Direct tools (`codemode: false`): a tool call named `<server>_<tool>`.
 */
export function extractCalls(messages: readonly unknown[], opts: ExtractOptions = {}): KbCall[] {
  const calls: KbCall[] = []
  for (const message of messages) {
    const m = asObject(message)
    if (m.type !== "assistant" || !Array.isArray(m.content)) continue
    for (const part of m.content) {
      const p = asObject(part)
      if (p.type !== "tool" || typeof p.name !== "string") continue
      const state = asObject(p.state)
      const base = {
        sessionID: typeof m.sessionID === "string" ? m.sessionID : undefined,
        messageID: typeof m.id === "string" ? m.id : undefined,
        callID: String(p.id ?? ""),
        at: Number(asObject(p.time).completed ?? asObject(p.time).created ?? 0),
      }
      if (p.name === "execute") {
        const nested = asObject(state.metadata).toolCalls
        if (Array.isArray(nested)) {
          nested.forEach((entry, index) => {
            const e = asObject(entry)
            if (typeof e.tool !== "string") return
            const dot = e.tool.indexOf(".")
            if (dot < 1 || !namespaceMatches(e.tool.slice(0, dot), opts)) return
            calls.push(makeCall({ ...base, callID: `${base.callID}#${index}` }, e.tool.slice(dot + 1), asObject(e.input), toStatus(e.status)))
          })
        } else if (typeof asObject(state.input).code === "string") {
          const code: string = state.input.code
          const re = /tools\s*(?:\.\s*([A-Za-z0-9_-]+)|\[\s*["']([^"']+)["']\s*\])\s*(?:\.\s*([A-Za-z0-9_]+)|\[\s*["']([^"']+)["']\s*\])\s*\(/g
          let match: RegExpExecArray | null
          let index = 0
          while ((match = re.exec(code))) {
            const ns = match[1] ?? match[2] ?? ""
            const tool = match[3] ?? match[4] ?? ""
            if (!tool || !namespaceMatches(ns, opts)) continue
            calls.push(makeCall({ ...base, callID: `${base.callID}~${index++}` }, tool, {}, toStatus(state.status), true))
          }
        }
        continue
      }
      const direct = /^([A-Za-z0-9-]*cartographer[A-Za-z0-9-]*|[A-Za-z0-9-]+)_(.+)$/.exec(p.name)
      if (direct && namespaceMatches(direct[1]!, opts)) {
        calls.push(makeCall(base, direct[2]!, asObject(state.input), toStatus(state.status)))
      }
    }
  }
  return calls
}

export interface KbActivity {
  kb: string
  reads: Array<{ id: string; count: number }>
  writes: Array<{ id: string; count: number }>
  searches: number
  otherReads: number
  otherWrites: number
  unclassified: number
  failed: number
  logAppends: number
  /** writes happened and no log_append followed the last one */
  needsLog: boolean
  lastAt: number
}

export interface SessionActivity {
  total: number
  byKb: KbActivity[]
  /** true when at least one KB has writes without a following log_append */
  needsLog: boolean
  /** set when the full history could not be loaded and only recent messages are counted */
  historyError?: string
}

const UNKNOWN_KB = "(unspecified)"

export function summarize(calls: readonly KbCall[], defaultKb?: string): SessionActivity {
  const map = new Map<string, KbActivity & { lastWriteAt: number; lastLogAt: number; r: Map<string, number>; w: Map<string, number> }>()
  const get = (kb: string) => {
    let a = map.get(kb)
    if (!a) {
      a = {
        kb, reads: [], writes: [], searches: 0, otherReads: 0, otherWrites: 0, unclassified: 0, failed: 0,
        logAppends: 0, needsLog: false, lastAt: 0, lastWriteAt: 0, lastLogAt: 0, r: new Map(), w: new Map(),
      }
      map.set(kb, a)
    }
    return a
  }
  const sorted = [...calls].sort((x, y) => x.at - y.at)
  for (const call of sorted) {
    const a = get(call.kb ?? defaultKb ?? UNKNOWN_KB)
    a.lastAt = Math.max(a.lastAt, call.at)
    if (call.status === "error") {
      a.failed++
      continue
    }
    if (call.status === "running") continue
    if (call.kind === "unclassified") {
      a.unclassified++
      continue
    }
    if (call.kind === "read") {
      if (call.tool === "search") a.searches++
      if (call.ids.length === 0) a.otherReads++
      for (const id of call.ids) a.r.set(id, (a.r.get(id) ?? 0) + 1)
      continue
    }
    if (call.tool === "log_append") {
      a.logAppends++
      a.lastLogAt = Math.max(a.lastLogAt, call.at)
      continue
    }
    a.lastWriteAt = Math.max(a.lastWriteAt, call.at)
    if (call.ids.length === 0) a.otherWrites++
    for (const id of call.ids) a.w.set(id, (a.w.get(id) ?? 0) + 1)
  }
  const byKb = [...map.values()].map((a) => {
    const toList = (m: Map<string, number>) =>
      [...m.entries()].map(([id, count]) => ({ id, count })).sort((x, y) => y.count - x.count || x.id.localeCompare(y.id))
    const wrote = a.w.size > 0 || a.otherWrites > 0
    return {
      kb: a.kb, reads: toList(a.r), writes: toList(a.w), searches: a.searches, otherReads: a.otherReads,
      otherWrites: a.otherWrites, unclassified: a.unclassified, failed: a.failed, logAppends: a.logAppends,
      needsLog: wrote && a.lastLogAt < a.lastWriteAt, lastAt: a.lastAt,
    } satisfies KbActivity
  })
  byKb.sort((x, y) => x.kb.localeCompare(y.kb))
  return { total: calls.length, byKb, needsLog: byKb.some((k) => k.needsLog) }
}
