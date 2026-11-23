import { describe, expect, test } from "bun:test"
import { loadSnapshot } from "../src/loader"
import { extractCalls, summarize } from "../src/session-activity"
import { badge, flatten, kbIssues, overall, panelSections, relTime, sidebarLines } from "../src/view"
import { parseKbStatus, unwrapCall } from "../src/model"
import { fixture } from "./helpers"

const run = async (req: any) => {
  if (req.kind === "status") return { ok: true as const, stdout: fixture("status.json") }
  const file = { kb_status: "kb_status.json", work_list: "work_list.json", changes_since: "changes.json", log_tail: "log.json" }[req.tool as string]!
  return { ok: true as const, stdout: fixture(file) }
}
const NOW = Date.parse("2026-11-23T17:00:00Z")

describe("view", () => {
  test("relTime", () => {
    expect(relTime("2026-11-23T16:59:50Z", NOW)).toBe("just now")
    expect(relTime("2026-11-23T14:00:00Z", NOW)).toBe("3h ago")
    expect(relTime("2026-11-20T17:00:00Z", NOW)).toBe("3d ago")
    expect(relTime(undefined, NOW)).toBe("—")
  })

  test("kbIssues surfaces push errors, drift and info items", () => {
    const base = parseKbStatus("k", unwrapCall(fixture("kb_status.json")))
    expect(kbIssues(base).map((i) => i.level)).toEqual(["info"])
    const bad = kbIssues({ ...base, pushLastError: "denied", unpushed: 2, behind: 1, stale: 3 })
    expect(bad[0]).toMatchObject({ level: "error" })
    expect(bad.map((i) => i.text).join("|")).toContain("2 commits not pushed")
  })

  test("badge and overview for a healthy workspace", async () => {
    const snap = await loadSnapshot(run, "/home/sc/syntphony", NOW)
    expect(badge(snap, undefined, false)).toEqual({ text: "KB 3 ℹ", level: "info" })
    expect(overall(snap).issues.length).toBeGreaterThan(0)
  })

  test("badge states without data", async () => {
    expect(badge(undefined, undefined, true).text).toBe("KB …")
    const snap = await loadSnapshot(async () => ({ ok: false, reason: "not-installed", message: "m" }), "/x", NOW)
    expect(badge(snap, undefined, false)).toEqual({ text: "KB —", level: "error" })
    const unbound = await loadSnapshot(run, "/tmp/z", NOW)
    expect(badge(unbound, undefined, false)).toMatchObject({ text: "KB 0 ⚠", level: "warn" })
    expect(overall(unbound).issues.map((i) => i.text).join()).toContain("read-only")
  })

  test("sidebar and panel include KBs, session activity and the log reminder", async () => {
    const snap = await loadSnapshot(run, "/home/sc/syntphony", NOW)
    const calls = extractCalls([
      { type: "assistant", id: "m", content: [{ type: "tool", id: "t", name: "execute", time: { created: 1, completed: NOW }, state: { status: "completed", input: {}, metadata: { toolCalls: [
        { tool: "cartographer.concept_read", status: "completed", input: { kb: "kb-shared", id: "meta-plan/x" } },
        { tool: "cartographer.concept_write", status: "completed", input: { kb: "kb-shared", id: "meta-plan/y" } },
      ] } } }] },
    ])
    const activity = summarize(calls)
    const side = sidebarLines(snap, activity, NOW).map((l) => l.text).join("\n")
    expect(side).toContain("kb-shared")
    expect(side).toContain("1r 1w · no log")
    const panel = flatten(panelSections(snap, activity, NOW)).map((l) => l.text).join("\n")
    expect(panel).toContain("bound by /home/sc/syntphony")
    expect(panel).toContain("meta-plan/x")
    expect(panel).toContain("writes without a following log_append")
    expect(panel).toContain("tokens of")
    expect(panel).not.toContain("gitlab")
  })

  test("panel while loading", () => {
    expect(panelSections(undefined, undefined, NOW)[0]!.lines[0]!.text).toBe("loading…")
  })
})
