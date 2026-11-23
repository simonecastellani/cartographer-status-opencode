import { readFileSync } from "node:fs"
import { join } from "node:path"

export const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
export const fixtureJson = (name: string) => JSON.parse(fixture(name))
