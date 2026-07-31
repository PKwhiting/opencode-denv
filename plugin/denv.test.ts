import { describe, expect, it } from "vitest"

import plugin from "./denv.js"
import {
  parseDenvSessionCommand,
  selectEnvByName,
  selectEnvForTitle,
  shSingleQuote,
  shSingleUnquote,
  stripSelfWrap,
} from "./denv.js"

describe("default plugin export", () => {
  it("uses the v1 object shape so named test exports are not loaded as plugins", () => {
    expect(plugin.id).toBe("opencode-denv")
    expect(plugin.server).toBeTypeOf("function")
  })
})

describe("selectEnvForTitle", () => {
  it("matches environment names case-insensitively", () => {
    expect(selectEnvForTitle("Fix API on DEV1", ["dev1"])).toBe("dev1")
  })

  it("prefers the longest matching environment name", () => {
    expect(selectEnvForTitle("work in dev-environ-5", ["dev", "dev-environ-5"])).toBe(
      "dev-environ-5",
    )
  })

  it("returns null when the title is not bound to an environment", () => {
    expect(selectEnvForTitle("local notes", ["dev1", "dev2"])).toBeNull()
  })
})

describe("selectEnvByName", () => {
  it("matches environment names case-insensitively", () => {
    expect(selectEnvByName("PRODUCTION", ["dev1", "production"])).toBe("production")
  })

  it("returns null for unknown environment names", () => {
    expect(selectEnvByName("missing", ["dev1", "production"])).toBeNull()
  })
})

describe("parseDenvSessionCommand", () => {
  const names = ["dev-environ-5", "production"]

  it("parses status commands", () => {
    expect(parseDenvSessionCommand("denv", names)).toEqual({ kind: "status" })
    expect(parseDenvSessionCommand("denv status", names)).toEqual({ kind: "status" })
  })

  it("parses environment switches", () => {
    expect(parseDenvSessionCommand("denv use PRODUCTION", names)).toEqual({
      kind: "use",
      env: "production",
    })
  })

  it("parses local and reset controls", () => {
    expect(parseDenvSessionCommand("denv local", names)).toEqual({ kind: "use", env: null })
    expect(parseDenvSessionCommand("denv reset", names)).toEqual({ kind: "reset" })
  })

  it("ignores non-denv commands", () => {
    expect(parseDenvSessionCommand("pwd", names)).toBeNull()
  })
})

describe("shell quoting", () => {
  it("round-trips single quoted command text", () => {
    const command = "printf 'hello world' && pwd"
    const quoted = shSingleQuote(command)

    expect(quoted.startsWith("'")).toBe(true)
    expect(quoted.endsWith("'")).toBe(true)
    expect(shSingleUnquote(quoted.slice(1, -1))).toBe(command)
  })
})

describe("stripSelfWrap", () => {
  it("unwraps denv-run commands", () => {
    expect(stripSelfWrap("denv-run dev1 'pwd'")).toBe("pwd")
  })

  it("unwraps absolute denv-run helper paths", () => {
    expect(stripSelfWrap("/Users/me/.config/opencode/denv-run dev1 'git status'")).toBe(
      "git status",
    )
  })

  it("unwraps nested denv-run commands", () => {
    const inner = `denv-run dev2 ${shSingleQuote("git status --short")}`
    const outer = `denv-run dev1 ${shSingleQuote(inner)}`

    expect(stripSelfWrap(outer)).toBe("git status --short")
  })

  it("leaves non-wrapper commands alone after trimming", () => {
    expect(stripSelfWrap("  cat denv-run  ")).toBe("cat denv-run")
  })
})
