import { describe, expect, test } from "bun:test"
import {
  applicableInstructions, parseChanges, parseKbStatus, parseLogTail, parseStatus, parseWorkList, resolveWorkspace, unwrapCall,
} from "../src/model"
import { fixture } from "./helpers"

describe("status", () => {
  const status = parseStatus(fixture("status.json"))

  test("reads connection, versions and the opencode provider", () => {
    expect(status.schemaOk).toBe(true)
    expect(status.reachable).toBe(true)
    expect(status.serverVersion).toBe("v0.29.1")
    expect(status.provider?.state).toBe("in_sync")
    expect(status.provider?.workspaces.map((w) => w.path)).toEqual(["/home/sc", "/home/sc/syntphony"])
  })

  test("flags an unexpected schema without throwing", () => {
    const s = parseStatus(JSON.stringify({ schema_version: "cartographer.status/v9", reachable: true, providers: [] }))
    expect(s.schemaOk).toBe(false)
    expect(s.provider).toBeUndefined()
  })

  test("rejects non-JSON", () => {
    expect(() => parseStatus("not json")).toThrow()
  })
})

describe("workspace resolution", () => {
  const { provider } = parseStatus(fixture("status.json"))

  test("longest binding wins", () => {
    expect(resolveWorkspace("/home/sc/syntphony/app/src", provider).kbs).toEqual(["kb-shared", "kb-functional", "kb-technical"])
    expect(resolveWorkspace("/home/sc/syntphony", provider).binding?.path).toBe("/home/sc/syntphony")
    expect(resolveWorkspace("/home/sc/other", provider).kbs).toEqual(["kb-personal"])
  })

  test("does not match a sibling that only shares a prefix", () => {
    expect(resolveWorkspace("/home/sc/syntphony-old", provider).binding?.path).toBe("/home/sc")
  })

  test("a folder under no binding has no KB", () => {
    const r = resolveWorkspace("/tmp/x", provider)
    expect(r.scope).toBe("none")
    expect(r.kbs).toEqual([])
  })

  test("global binding when there are no workspaces", () => {
    const r = resolveWorkspace("/anything", { state: "in_sync", boundKbs: ["a", "b"], workspaces: [], instructions: [] })
    expect(r).toEqual({ scope: "global", kbs: ["a", "b"] })
  })

  test("instructions blocks apply from the folder or an ancestor", () => {
    const blocks = provider!.instructions
    expect(applicableInstructions("/home/sc/syntphony/x", blocks).map((b) => b.path)).toEqual(["/home/sc/AGENTS.md", "/home/sc/syntphony/AGENTS.md"])
    expect(applicableInstructions("/home/sc/other", blocks).map((b) => b.path)).toEqual(["/home/sc/AGENTS.md"])
  })
})

describe("tool results", () => {
  test("kb_status is normalized and drops the remote url", () => {
    const text = unwrapCall(fixture("kb_status.json"))
    const h = parseKbStatus("kb-shared", text)
    expect(h.total).toBe(85)
    expect(h.byStatus["done"]).toBe(45)
    expect(h.openConcepts).toBe(5)
    expect(h.pushState).toBe("clean")
    expect(h.uiUrl).toContain("/ui/")
    expect(JSON.stringify(h)).not.toContain("gitlab")
  })

  test("work_list, changes_since and log_tail", () => {
    const work = parseWorkList(unwrapCall(fixture("work_list.json")))
    expect(work.total).toBe(5)
    expect(work.entries[0]?.id).toBe("meta-plan/execution-log")
    const changes = parseChanges(unwrapCall(fixture("changes.json")))
    expect(changes.concepts[0]?.authors).toEqual(["Alice Example"])
    expect(changes.commitCount).toBeGreaterThan(0)
    const log = parseLogTail(unwrapCall(fixture("log.json")))
    expect(log).toHaveLength(2)
    expect(log[0]?.summary).toBe("concept_batch · meta-decisions/2026-11-20-pptx-skill-vendored-as-syn-pptx")
  })

  test("unwrapCall fails on an unexpected shape", () => {
    expect(() => unwrapCall("{}")).toThrow()
  })
})
