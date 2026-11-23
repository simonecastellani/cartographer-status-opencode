import { describe, expect, test } from "bun:test"
import { extractCalls, summarize } from "../src/session-activity"
import { fixtureJson } from "./helpers"

const tool = (name: string, state: any, id = "t1", completed = 1000) => ({
  type: "assistant", id: "m1", sessionID: "ses_1", content: [{ type: "tool", id, name, state, time: { created: completed - 10, completed } }],
})
const exec = (calls: any[], at = 1000, id = "e1") => tool("execute", { status: "completed", input: { code: "…" }, metadata: { toolCalls: calls } }, id, at)

describe("extractCalls", () => {
  test("reads the real Code Mode message", () => {
    const calls = extractCalls(fixtureJson("messages-codemode.json"))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ tool: "atlas_overview", kind: "read", kb: "kb-personal", status: "completed" })
  })

  test("reads direct tools named <server>_<tool>", () => {
    const calls = extractCalls([tool("cartographer_concept_read", { status: "completed", input: { kb: "kb-a", id: "x/y" } })])
    expect(calls).toMatchObject([{ tool: "concept_read", kb: "kb-a", ids: ["x/y"], kind: "read" }])
  })

  test("ignores other servers and built-in tools", () => {
    const calls = extractCalls([
      exec([{ tool: "context7.search", status: "completed", input: { query: "q" } }]),
      tool("shell", { status: "completed", input: { command: "ls" } }),
      tool("read_file", { status: "completed", input: {} }, "t3"),
    ])
    expect(calls).toEqual([])
  })

  test("honors a custom server name", () => {
    const calls = extractCalls([exec([{ tool: "kbserver.concept_read", status: "completed", input: { kb: "k", id: "a" } }])], { namespaces: ["kbserver"] })
    expect(calls).toHaveLength(1)
  })

  test("collects ids from batches, moves and graph_context, and never bodies", () => {
    const calls = extractCalls([
      exec([
        { tool: "cartographer.concept_batch", status: "completed", input: { kb: "k", operations: [{ id: "a", body: "SECRET" }, { id: "b" }] } },
        { tool: "cartographer.concept_move", status: "completed", input: { kb: "k", moves: [{ source_id: "c", target_id: "d" }] } },
        { tool: "cartographer.graph_context", status: "completed", input: { kb: "k", ids: ["e"], query: "q" } },
      ]),
    ])
    expect(calls.map((c) => c.ids)).toEqual([["a", "b"], ["c", "d"], ["e"]])
    expect(JSON.stringify(calls)).not.toContain("SECRET")
  })

  test("artifact tools are identified by path", () => {
    const calls = extractCalls([exec([{ tool: "cartographer.artifact_write", status: "completed", input: { kb: "k", path: "skills/x/SKILL.md", content: "BODY" } }])])
    expect(calls[0]!.ids).toEqual(["skills/x/SKILL.md"])
    expect(JSON.stringify(calls)).not.toContain("BODY")
  })

  test("falls back to scanning the code when metadata is missing", () => {
    const calls = extractCalls([tool("execute", { status: "running", input: { code: 'await tools.cartographer.concept_read({kb:"k"}); await tools["cartographer"].log_append({})' } })])
    expect(calls.map((c) => [c.tool, c.approx])).toEqual([["concept_read", true], ["log_append", true]])
  })

  test("tolerates malformed messages", () => {
    expect(extractCalls([null, 1, {}, { type: "assistant" }, { type: "assistant", content: [{ type: "tool" }] }])).toEqual([])
  })
})

describe("summarize", () => {
  test("counts reads and writes per KB and spots a missing log entry", () => {
    const calls = extractCalls([
      exec([{ tool: "cartographer.concept_read", status: "completed", input: { kb: "a", id: "x" } }, { tool: "cartographer.concept_read", status: "completed", input: { kb: "a", id: "x" } }], 1000, "e1"),
      exec([{ tool: "cartographer.search", status: "completed", input: { kb: "a", query: "foo" } }], 1100, "e2"),
      exec([{ tool: "cartographer.concept_write", status: "completed", input: { kb: "a", id: "w1", body: "B" } }], 1200, "e3"),
    ])
    const s = summarize(calls)
    expect(s.byKb[0]).toMatchObject({ kb: "a", searches: 1, needsLog: true })
    expect(s.byKb[0]!.reads).toEqual([{ id: "x", count: 2 }])
    expect(s.byKb[0]!.writes).toEqual([{ id: "w1", count: 1 }])
    expect(s.needsLog).toBe(true)
  })

  test("a log_append after the last write clears the reminder", () => {
    const calls = extractCalls([
      exec([{ tool: "cartographer.concept_write", status: "completed", input: { kb: "a", id: "w" } }], 1000, "e1"),
      exec([{ tool: "cartographer.log_append", status: "completed", input: { kb: "a", entry: "e" } }], 1500, "e2"),
    ])
    const s = summarize(calls)
    expect(s.needsLog).toBe(false)
    expect(s.byKb[0]!.logAppends).toBe(1)
  })

  test("failed and unknown tools do not count as reads or writes", () => {
    const calls = extractCalls([
      exec([
        { tool: "cartographer.concept_write", status: "error", input: { kb: "a", id: "w" } },
        { tool: "cartographer.future_tool", status: "completed", input: { kb: "a" } },
      ]),
    ])
    const a = summarize(calls).byKb[0]!
    expect(a).toMatchObject({ failed: 1, unclassified: 1, writes: [], reads: [], needsLog: false })
  })

  test("uses the default KB when a call names none", () => {
    const s = summarize(extractCalls([exec([{ tool: "cartographer.concept_read", status: "completed", input: { id: "x" } }])]), "only-kb")
    expect(s.byKb[0]!.kb).toBe("only-kb")
  })
})
