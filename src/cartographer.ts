// The ONLY place in this plugin that starts a process. Read-only by construction:
// requests are a closed set, tools and arguments come from allowlists, and
// anything else is rejected before a process is spawned.
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"

export const ALLOWED_TOOLS = ["kb_status", "work_list", "changes_since", "log_tail"] as const
export type AllowedTool = (typeof ALLOWED_TOOLS)[number]

const ALLOWED_ARGS: Record<AllowedTool, readonly string[]> = {
  kb_status: [],
  work_list: ["limit"],
  changes_since: ["since", "limit"],
  log_tail: ["n"],
}

export type Request =
  | { kind: "status" }
  | { kind: "workspace-list" }
  | { kind: "tool"; tool: AllowedTool; kb: string; dir: string; args?: Record<string, string | number> }

export type RunResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "not-installed" | "timeout" | "failed" | "rejected"; message: string }

export type Exec = (
  bin: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
) => Promise<{ code: number; stdout: string; stderr: string; errorCode?: string; killed?: boolean }>

const KB_NAME = /^[A-Za-z0-9._-]+$/
const ARG_VALUE = /^[A-Za-z0-9:.+-]+$/

export function buildArgs(req: Request, provider = "opencode"): string[] {
  if (!/^[a-z0-9-]+$/.test(provider)) throw new Error(`provider not allowed: ${provider}`)
  switch (req.kind) {
    case "status":
      return ["status", "--output", "json"]
    case "workspace-list":
      return ["workspace", "list", provider]
    case "tool": {
      if (!(ALLOWED_TOOLS as readonly string[]).includes(req.tool)) throw new Error(`tool not allowed: ${req.tool}`)
      if (!KB_NAME.test(req.kb)) throw new Error(`kb name not allowed: ${req.kb}`)
      if (typeof req.dir !== "string" || !req.dir.startsWith("/")) throw new Error("dir must be an absolute path")
      const extra: string[] = []
      for (const [key, value] of Object.entries(req.args ?? {})) {
        if (!ALLOWED_ARGS[req.tool].includes(key)) throw new Error(`argument not allowed for ${req.tool}: ${key}`)
        const text = String(value)
        if (!ARG_VALUE.test(text)) throw new Error(`argument value not allowed: ${key}`)
        extra.push(`${key}=${text}`)
      }
      return ["call", "--provider", provider, req.tool, `kb=${req.kb}`, ...extra, "--dir", req.dir, "--output", "json", "--timeout", "12s"]
    }
    default:
      throw new Error("request not allowed")
  }
}

const defaultExec: Exec = (bin, args, opts) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: opts.timeout, maxBuffer: opts.maxBuffer, env: process.env }, (error, stdout, stderr) => {
      const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        errorCode: e && typeof e.code === "string" ? e.code : undefined,
        killed: e?.killed,
      })
    })
  })

const BIN_CANDIDATES = [
  "/home/linuxbrew/.linuxbrew/bin/cartographer",
  "/opt/homebrew/bin/cartographer",
  "/usr/local/bin/cartographer",
]

export function findBinary(env: Record<string, string | undefined> = process.env, exists = existsSync): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && exists(join(dir, "cartographer"))) return join(dir, "cartographer")
  }
  const home = env.HOME
  const candidates = home ? [join(home, ".local/bin/cartographer"), ...BIN_CANDIDATES] : BIN_CANDIDATES
  return candidates.find((candidate) => exists(candidate))
}

export interface RunnerOptions {
  bin?: string
  provider?: string
  timeoutMs?: number
  exec?: Exec
}

export function createRunner(options: RunnerOptions = {}) {
  const exec = options.exec ?? defaultExec
  const provider = options.provider ?? "opencode"
  const timeout = options.timeoutMs ?? 20_000
  return async function runCartographer(req: Request): Promise<RunResult> {
    let args: string[]
    try {
      args = buildArgs(req, provider)
    } catch (error) {
      return { ok: false, reason: "rejected", message: error instanceof Error ? error.message : String(error) }
    }
    const bin = options.bin ?? findBinary()
    if (!bin) return { ok: false, reason: "not-installed", message: "cartographer binary not found" }
    const result = await exec(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 })
    if (result.errorCode === "ENOENT") return { ok: false, reason: "not-installed", message: "cartographer binary not found" }
    if (result.killed) return { ok: false, reason: "timeout", message: "cartographer timed out" }
    if (result.code !== 0) {
      const message = (result.stderr || result.stdout || `exit ${result.code}`).trim().split("\n")[0]!.slice(0, 300)
      return { ok: false, reason: "failed", message }
    }
    return { ok: true, stdout: result.stdout }
  }
}
