import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const root = join(import.meta.dir, "..")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (name === "node_modules" || name === "test") return []
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const sources = walk(root).filter((f) => /\.(ts|tsx)$/.test(f))

describe("read-only guarantees", () => {
  test("only src/cartographer.ts can start a process", () => {
    const offenders = sources.filter((f) => /child_process|Bun\.spawn|Bun\.\$|execSync|spawnSync|\bexecFile\b|\bspawn\(/.test(readFileSync(f, "utf8")))
    expect(offenders.map((f) => relative(root, f))).toEqual(["src/cartographer.ts"])
  })

  test("the plugin never uses fs APIs that write", () => {
    const offenders = sources.filter((f) => /writeFile|appendFile|rmSync|unlinkSync|renameSync|mkdirSync|createWriteStream/.test(readFileSync(f, "utf8")))
    expect(offenders.map((f) => relative(root, f))).toEqual([])
  })

  test("no write tool of Cartographer is ever named outside the activity classifier and the allowlist guard", () => {
    const writeTool = /["'`](concept_write|concept_patch|concept_batch|concept_delete|log_append|artifact_write|snapshot|kb_repair)["'`]/
    const offenders = sources.filter((f) => writeTool.test(readFileSync(f, "utf8"))).map((f) => relative(root, f))
    expect(offenders).toEqual(["src/session-activity.ts"])
  })

  test("the plugin does not call the network", () => {
    const offenders = sources.filter((f) => /\bfetch\(|XMLHttpRequest|WebSocket|node:https?|node:net/.test(readFileSync(f, "utf8")))
    expect(offenders.map((f) => relative(root, f))).toEqual([])
  })
})
