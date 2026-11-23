// Keeps the Cartographer calls of each session, read from the session's messages.
// Only fetches (read-only). Messages are paged by the server and the TUI keeps just a window of
// them, so the full history is loaded once per session and later refreshed from the newest page.
import { extractCalls, type ExtractOptions, type KbCall } from "./session-activity"

export interface Page {
  data: unknown[]
  next?: string | null
}

export interface PageQuery {
  sessionID: string
  type: "assistant"
  limit: string
  order?: "asc" | "desc"
  cursor?: string
}

export type FetchPage = (query: PageQuery) => Promise<Page>

export interface TrackerOptions extends ExtractOptions {
  fetchPage: FetchPage
  onChange?: (sessionID: string) => void
  maxPages?: number
  /** a failed load is not retried before this delay, so a broken client cannot cause a retry loop */
  retryMs?: number
  now?: () => number
}

export function createTracker(options: TrackerOptions) {
  const bySession = new Map<string, Map<string, KbCall[]>>()
  const loads = new Map<string, Promise<void>>()
  const maxPages = options.maxPages ?? 40
  const retryMs = options.retryMs ?? 30_000
  const now = options.now ?? Date.now
  const failures = new Map<string, { message: string; at: number }>()

  const store = (sessionID: string) => {
    let m = bySession.get(sessionID)
    if (!m) bySession.set(sessionID, (m = new Map()))
    return m
  }

  function merge(sessionID: string, messages: unknown[]) {
    const m = store(sessionID)
    for (const message of messages) {
      const id = (message as { id?: unknown })?.id
      if (typeof id !== "string") continue
      const calls = extractCalls([message], options).map((c) => ({ ...c, sessionID }))
      if (calls.length) m.set(id, calls)
      else m.delete(id)
    }
  }

  async function load(sessionID: string): Promise<void> {
    let cursor: string | undefined
    for (let page = 0; page < maxPages; page++) {
      const result = await options.fetchPage(cursor ? { sessionID, type: "assistant", limit: "100", cursor } : { sessionID, type: "assistant", limit: "100", order: "asc" })
      if (!result.data.length) break
      merge(sessionID, result.data)
      if (!result.next) break
      cursor = result.next
    }
  }

  /** Loads the whole history once; later calls return the same promise (a failure is retried after retryMs). */
  function ensure(sessionID: string): Promise<void> {
    const failed = failures.get(sessionID)
    let p = loads.get(sessionID)
    if (p && failed && now() - failed.at >= retryMs) {
      loads.delete(sessionID)
      p = undefined
    }
    if (!p) {
      p = load(sessionID).then(
        () => {
          failures.delete(sessionID)
          options.onChange?.(sessionID)
        },
        (error) => {
          failures.set(sessionID, { message: error instanceof Error ? error.message : String(error), at: now() })
        },
      )
      loads.set(sessionID, p)
    }
    return p
  }

  /** Re-reads the newest messages (a running tool call changes state after it is first seen). */
  async function refreshLatest(sessionID: string): Promise<void> {
    await ensure(sessionID)
    try {
      const result = await options.fetchPage({ sessionID, type: "assistant", limit: "20", order: "desc" })
      merge(sessionID, result.data)
      options.onChange?.(sessionID)
    } catch {}
  }

  const calls = (sessionIDs: readonly string[]): KbCall[] => sessionIDs.flatMap((id) => [...(bySession.get(id)?.values() ?? [])].flat())
  const isLoaded = (sessionID: string) => loads.has(sessionID) && !failures.has(sessionID)
  const lastError = (sessionIDs: readonly string[]) => sessionIDs.map((id) => failures.get(id)?.message).find(Boolean)

  return { ensure, refreshLatest, calls, isLoaded, lastError }
}
