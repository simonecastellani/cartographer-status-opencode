import { describe, expect, test } from "bun:test"
import type { Request, RunResult } from "../src/cartographer"
import { createStore, loadSnapshot, type Run } from "../src/loader"
import { fixture } from "./helpers"

function fakeRun(overrides: Partial<Record<string, RunResult>> = {}) {
  const requests: Request[] = []
  const run: Run = async (req) => {
    requests.push(req)
    const key = req.kind === "tool" ? `${req.tool}:${req.kb}` : req.kind
    if (overrides[key]) return overrides[key]!
    if (req.kind === "status") return { ok: true, stdout: fixture("status.json") }
    if (req.kind === "tool") {
      const file = { kb_status: "kb_status.json", work_list: "work_list.json", changes_since: "changes.json", log_tail: "log.json" }[req.tool]
      return { ok: true, stdout: fixture(file) }
    }
    return { ok: false, reason: "rejected", message: "unexpected" }
  }
  return { run, requests }
}

describe("loadSnapshot", () => {
  test("loads every KB of the workspace with only read-only requests", async () => {
    const { run, requests } = fakeRun()
    const snap = await loadSnapshot(run, "/home/sc/syntphony", 1)
    expect(Object.keys(snap.kbs)).toEqual(["kb-shared", "kb-functional", "kb-technical"])
    expect(snap.kbs["kb-shared"]!.health?.total).toBe(85)
    expect(snap.kbs["kb-shared"]!.errors).toEqual([])
    const tools = new Set(requests.flatMap((r) => (r.kind === "tool" ? [r.tool] : [])))
    expect([...tools].sort()).toEqual(["changes_since", "kb_status", "log_tail", "work_list"])
    expect(requests.every((r) => r.kind !== "tool" || r.dir === "/home/sc/syntphony")).toBe(true)
  })

  test("an unbound folder loads no KB and calls no tool", async () => {
    const { run, requests } = fakeRun()
    const snap = await loadSnapshot(run, "/tmp/x", 1)
    expect(snap.resolution?.scope).toBe("none")
    expect(requests.filter((r) => r.kind === "tool")).toEqual([])
  })

  test("a failing section does not hide the others", async () => {
    const { run } = fakeRun({ "work_list:kb-personal": { ok: false, reason: "failed", message: "boom" } })
    const snap = await loadSnapshot(run, "/home/sc", 1)
    const data = snap.kbs["kb-personal"]!
    expect(data.health).toBeDefined()
    expect(data.work).toBeUndefined()
    expect(data.errors).toEqual(["work: boom"])
  })

  test("reports a missing binary and an unreachable server", async () => {
    const missing = await loadSnapshot(async () => ({ ok: false, reason: "not-installed", message: "x" }), "/home/sc", 1)
    expect(missing.error?.reason).toBe("not-installed")
    const down = await loadSnapshot(async () => ({ ok: true, stdout: JSON.stringify({ schema_version: "cartographer.status/v1", reachable: false }) }), "/home/sc", 1)
    expect(down.error?.reason).toBe("unreachable")
  })

  test("garbage status output is a schema error", async () => {
    const snap = await loadSnapshot(async () => ({ ok: true, stdout: "nope" }), "/home/sc", 1)
    expect(snap.error?.reason).toBe("schema")
  })
})

describe("store", () => {
  test("caches within the TTL, dedupes in-flight loads and honors force", async () => {
    const { run, requests } = fakeRun()
    let t = 0
    const store = createStore({ run, ttlMs: 1000, now: () => t })
    const [a, b] = await Promise.all([store.refresh("/home/sc"), store.refresh("/home/sc")])
    expect(a).toBe(b)
    const calls = requests.length
    await store.refresh("/home/sc")
    expect(requests.length).toBe(calls)
    t = 2000
    await store.refresh("/home/sc")
    expect(requests.length).toBeGreaterThan(calls)
    const before = requests.length
    await store.refresh("/home/sc", { force: true })
    expect(requests.length).toBeGreaterThan(before)
  })

  test("notifies listeners", async () => {
    const { run } = fakeRun()
    const events: boolean[] = []
    const store = createStore({ run, onChange: (_s, loading) => events.push(loading) })
    await store.refresh("/home/sc")
    expect(events).toEqual([true, false])
  })
})
