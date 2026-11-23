import { describe, expect, test } from "bun:test"
import { createTracker, type FetchPage, type PageQuery } from "../src/session-tracker"

const msg = (id: string, calls: Array<{ tool: string; input?: any; status?: string }>) => ({
  type: "assistant",
  id,
  content: [{ type: "tool", id: "t-" + id, name: "execute", time: { created: 1, completed: 2 }, state: { status: "completed", input: {}, metadata: { toolCalls: calls.map((c) => ({ status: "completed", input: {}, ...c })) } } }],
})

describe("tracker", () => {
  test("pages through the whole history once, then merges the newest page", async () => {
    const seen: PageQuery[] = []
    let phase = 0
    const fetchPage: FetchPage = async (q) => {
      seen.push(q)
      if (q.order === "desc") return { data: [msg("m2", [{ tool: "cartographer.concept_write", input: { kb: "a", id: "w" } }]), msg("m3", [{ tool: "cartographer.log_append", input: { kb: "a" } }])] }
      if (!q.cursor) return { data: [msg("m1", [{ tool: "cartographer.concept_read", input: { kb: "a", id: "x" } }]), msg("m2", [{ tool: "cartographer.concept_read", input: { kb: "a", id: "y" } }])], next: "c1" }
      phase++
      return { data: [] }
    }
    const changes: string[] = []
    const t = createTracker({ fetchPage, onChange: (s) => changes.push(s) })
    await Promise.all([t.ensure("s1"), t.ensure("s1")])
    expect(seen.filter((q) => !q.order && q.cursor)).toHaveLength(1)
    expect(phase).toBe(1)
    expect(t.calls(["s1"]).map((c) => c.ids[0]).sort()).toEqual(["x", "y"])
    await t.refreshLatest("s1")
    expect(t.calls(["s1"]).map((c) => c.tool).sort()).toEqual(["concept_read", "concept_write", "log_append"])
    expect(changes.length).toBeGreaterThanOrEqual(2)
  })

  test("a failing fetch is not retried in a loop, and recovers after the delay", async () => {
    let fail = true
    let attempts = 0
    let t0 = 0
    const changes: string[] = []
    const fetchPage: FetchPage = async () => {
      attempts++
      if (fail) throw new Error("down")
      return { data: [msg("m1", [{ tool: "cartographer.search", input: { kb: "a", query: "q" } }])] }
    }
    const t = createTracker({ fetchPage, retryMs: 1000, now: () => t0, onChange: (s) => changes.push(s) })
    await t.ensure("s")
    await t.ensure("s")
    await t.ensure("s")
    expect(attempts).toBe(1)
    expect(changes).toEqual([])
    expect(t.lastError(["s"])).toBe("down")
    expect(t.isLoaded("s")).toBe(false)
    fail = false
    t0 = 1500
    await t.ensure("s")
    expect(t.calls(["s"])).toHaveLength(1)
    expect(t.lastError(["s"])).toBeUndefined()
    expect(changes).toEqual(["s"])
  })

  test("merges the calls of a whole session family", async () => {
    const fetchPage: FetchPage = async (q) => ({ data: [msg("m-" + q.sessionID, [{ tool: "cartographer.concept_read", input: { kb: "a", id: q.sessionID } }])] })
    const t = createTracker({ fetchPage })
    await Promise.all([t.ensure("p"), t.ensure("c")])
    expect(t.calls(["p", "c"]).map((c) => c.sessionID).sort()).toEqual(["c", "p"])
  })
})
