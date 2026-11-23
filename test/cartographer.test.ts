import { describe, expect, test } from "bun:test"
import { ALLOWED_TOOLS, buildArgs, createRunner, findBinary, type Exec, type Request } from "../src/cartographer"

const ok: Exec = async () => ({ code: 0, stdout: "{}", stderr: "" })

describe("allowlist", () => {
  test("only read-only tools are allowed", () => {
    expect([...ALLOWED_TOOLS].sort()).toEqual(["changes_since", "kb_status", "log_tail", "work_list"])
  })

  test("builds the expected command lines", () => {
    expect(buildArgs({ kind: "status" })).toEqual(["status", "--output", "json"])
    expect(buildArgs({ kind: "workspace-list" })).toEqual(["workspace", "list", "opencode"])
    expect(buildArgs({ kind: "tool", tool: "changes_since", kb: "kb-shared", dir: "/work", args: { since: "7d", limit: 5 } })).toEqual([
      "call", "--provider", "opencode", "changes_since", "kb=kb-shared", "since=7d", "limit=5", "--dir", "/work", "--output", "json", "--timeout", "12s",
    ])
  })

  const writes = [
    "concept_write", "concept_patch", "concept_batch", "concept_delete", "concept_move", "log_append",
    "artifact_write", "artifact_delete", "snapshot", "kb_repair", "secret_set", "supersede", "gate_check", "lint",
  ]
  for (const tool of writes) {
    test(`rejects ${tool}`, async () => {
      let spawned = false
      const run = createRunner({ bin: "/bin/true", exec: async () => ((spawned = true), { code: 0, stdout: "", stderr: "" }) })
      const result = await run({ kind: "tool", tool: tool as any, kb: "kb", dir: "/x" })
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toBe("rejected")
      expect(spawned).toBe(false)
    })
  }

  test("rejects unknown request kinds, bad kb names, relative dirs and unlisted arguments", async () => {
    const run = createRunner({ bin: "/bin/true", exec: ok })
    const bad: unknown[] = [
      { kind: "sync" },
      { kind: "connect" },
      { kind: "tool", tool: "kb_status", kb: "kb; rm -rf /", dir: "/x" },
      { kind: "tool", tool: "kb_status", kb: "kb", dir: "relative" },
      { kind: "tool", tool: "kb_status", kb: "kb", dir: "/x", args: { reason: "x" } },
      { kind: "tool", tool: "work_list", kb: "kb", dir: "/x", args: { limit: "5; ls" } },
      { kind: "tool", tool: "log_tail", kb: "kb", dir: "/x", args: { path: "a" } },
    ]
    for (const req of bad) {
      const result = await run(req as Request)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toBe("rejected")
    }
  })
})

describe("runner", () => {
  test("reports a missing binary", async () => {
    const run = createRunner({ bin: "/nope/cartographer", exec: async () => ({ code: 1, stdout: "", stderr: "", errorCode: "ENOENT" }) })
    const r = await run({ kind: "status" })
    expect(r.ok === false && r.reason).toBe("not-installed")
  })

  test("reports a timeout", async () => {
    const run = createRunner({ bin: "/b", exec: async () => ({ code: 1, stdout: "", stderr: "", killed: true }) })
    const r = await run({ kind: "status" })
    expect(r.ok === false && r.reason).toBe("timeout")
  })

  test("reports a failing command with its first line", async () => {
    const run = createRunner({ bin: "/b", exec: async () => ({ code: 1, stdout: "", stderr: 'kb "x" is not available\nmore', }) })
    const r = await run({ kind: "status" })
    expect(r).toEqual({ ok: false, reason: "failed", message: 'kb "x" is not available' })
  })

  test("passes stdout through", async () => {
    const run = createRunner({ bin: "/b", exec: async () => ({ code: 0, stdout: "OUT", stderr: "" }) })
    expect(await run({ kind: "status" })).toEqual({ ok: true, stdout: "OUT" })
  })
})

describe("findBinary", () => {
  test("uses PATH first, then well-known locations", () => {
    expect(findBinary({ PATH: "/a:/b" }, (p) => p === "/b/cartographer")).toBe("/b/cartographer")
    expect(findBinary({ PATH: "/a", HOME: "/h" }, (p) => p === "/home/linuxbrew/.linuxbrew/bin/cartographer")).toBe(
      "/home/linuxbrew/.linuxbrew/bin/cartographer",
    )
    expect(findBinary({ PATH: "/a" }, () => false)).toBeUndefined()
  })
})
