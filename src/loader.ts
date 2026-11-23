import type { RunResult, Request } from "./cartographer"
import {
  applicableInstructions,
  parseChanges,
  parseKbStatus,
  parseLogTail,
  parseStatus,
  parseWorkList,
  resolveWorkspace,
  unwrapCall,
  type KbData,
  type Snapshot,
} from "./model"

export type Run = (req: Request) => Promise<RunResult>

async function section<T>(errors: string[], label: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export async function loadKb(run: Run, kb: string, dir: string, now: number): Promise<KbData> {
  const errors: string[] = []
  const call = async (tool: "kb_status" | "work_list" | "changes_since" | "log_tail", args?: Record<string, string | number>) => {
    const result = await run({ kind: "tool", tool, kb, dir, args })
    if (!result.ok) throw new Error(result.message)
    return unwrapCall(result.stdout)
  }
  const [health, work, changes, log] = await Promise.all([
    section(errors, "status", async () => parseKbStatus(kb, await call("kb_status"))),
    section(errors, "work", async () => parseWorkList(await call("work_list", { limit: 5 }))),
    section(errors, "changes", async () => parseChanges(await call("changes_since", { since: "7d", limit: 5 }))),
    section(errors, "log", async () => parseLogTail(await call("log_tail", { n: 3 }))),
  ])
  return { kb, health, work, changes, log, errors, fetchedAt: now }
}

export async function loadSnapshot(run: Run, dir: string, now = Date.now(), provider = "opencode"): Promise<Snapshot> {
  const base: Snapshot = { dir, at: now, instructions: [], kbs: {} }
  const result = await run({ kind: "status" })
  if (!result.ok) {
    return { ...base, error: { reason: result.reason === "not-installed" ? "not-installed" : "failed", message: result.message } }
  }
  let status
  try {
    status = parseStatus(result.stdout, provider)
  } catch (error) {
    return { ...base, error: { reason: "schema", message: error instanceof Error ? error.message : String(error) } }
  }
  const snap: Snapshot = { ...base, status }
  if (!status.reachable) {
    return { ...snap, error: { reason: "unreachable", message: "Cartographer server is not reachable" } }
  }
  const resolution = resolveWorkspace(dir, status.provider)
  snap.resolution = resolution
  snap.instructions = status.provider ? applicableInstructions(dir, status.provider.instructions) : []
  const loaded = await Promise.all(resolution.kbs.map((kb) => loadKb(run, kb, dir, now)))
  for (const data of loaded) snap.kbs[data.kb] = data
  if (!status.schemaOk) {
    snap.error = { reason: "schema", message: `unexpected status schema "${status.schemaVersion}"; data may be incomplete` }
  }
  return snap
}

export interface StoreOptions {
  run: Run
  ttlMs?: number
  now?: () => number
  onChange?: (snapshot: Snapshot | undefined, loading: boolean) => void
}

/** Cache with a short TTL and one in-flight load per folder. */
export function createStore(options: StoreOptions) {
  const ttl = options.ttlMs ?? 30_000
  const now = options.now ?? Date.now
  let current: Snapshot | undefined
  let inflight: { dir: string; promise: Promise<Snapshot> } | undefined
  const emit = (loading: boolean) => options.onChange?.(current, loading)

  async function refresh(dir: string, opts: { force?: boolean } = {}): Promise<Snapshot> {
    if (!opts.force && current && current.dir === dir && now() - current.at < ttl) return current
    if (inflight && inflight.dir === dir) return inflight.promise
    emit(true)
    const promise = loadSnapshot(options.run, dir, now()).then((snap) => {
      current = snap
      inflight = undefined
      emit(false)
      return snap
    })
    inflight = { dir, promise }
    return promise
  }

  return {
    refresh,
    get: () => current,
    isLoading: () => inflight !== undefined,
  }
}
