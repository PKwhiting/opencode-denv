import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

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
    expect(parseDenvSessionCommand("denv use", names)).toEqual({ kind: "list" })
    expect(parseDenvSessionCommand("denv use PRODUCTION", names)).toEqual({
      kind: "use",
      env: "production",
    })
    expect(parseDenvSessionCommand("denv production", names)).toEqual({
      kind: "use",
      env: "production",
    })
    expect(parseDenvSessionCommand("denv switch production", names)).toEqual({
      kind: "use",
      env: "production",
    })
    expect(parseDenvSessionCommand("denv use 'production' # switch this chat", names)).toEqual({
      kind: "use",
      env: "production",
    })
  })

  it("treats help forms as the environment list", () => {
    expect(parseDenvSessionCommand("denv help", names)).toEqual({ kind: "list" })
    expect(parseDenvSessionCommand("denv --help", names)).toEqual({ kind: "list" })
    expect(parseDenvSessionCommand("denv use production --help", names)).toEqual({ kind: "list" })
  })

  it("parses the absolute local control-command path", () => {
    expect(parseDenvSessionCommand("/root/.config/opencode/denv use PRODUCTION", names)).toEqual({
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
    expect(parseDenvSessionCommand("denv-run production 'pwd'", names)).toBeNull()
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

type TestHooks = {
  "tool.execute.before": (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: Record<string, unknown> },
  ) => Promise<void>
  "shell.env": (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> },
  ) => Promise<void>
}

describe("session override routing", () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("shares fresh overrides and local control calls across plugin instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-denv-"))
    temporaryDirectories.push(directory)
    const envsPath = join(directory, "envs.json")
    const overridesPath = join(directory, "session-envs.json")
    writeFileSync(envsPath, JSON.stringify({
      production: { host: "production.example", workspace: "/workspace" },
    }))
    vi.stubEnv("DENV_ENVS", envsPath)
    vi.stubEnv("DENV_SESSION_ENVS", overridesPath)
    vi.resetModules()

    const { DenvPlugin: isolatedPlugin } = await import("./denv.js")
    const client = {
      app: { log: async () => ({}) },
      session: { get: async () => ({ data: { title: "local session" } }) },
    }
    const first = await isolatedPlugin({ client } as never) as unknown as TestHooks
    const second = await isolatedPlugin({ client } as never) as unknown as TestHooks

    const productionCommand = { args: { command: "denv use production" } }
    await first["tool.execute.before"](
      { tool: "bash", sessionID: "production-session", callID: "switch-production" },
      productionCommand,
    )
    expect(productionCommand.args.command).toContain("session now uses production")

    const controlEnvironment = { env: {} as Record<string, string> }
    await second["shell.env"](
      { cwd: directory, sessionID: "production-session", callID: "switch-production" },
      controlEnvironment,
    )
    expect(controlEnvironment.env.DENV_TARGET_ENV).toBe("")

    const productionEnvironment = { env: {} as Record<string, string> }
    await second["shell.env"](
      { cwd: directory, sessionID: "production-session", callID: "ordinary-command" },
      productionEnvironment,
    )
    expect(productionEnvironment.env.DENV_TARGET_ENV).toBe("production")

    await second["tool.execute.before"](
      { tool: "bash", sessionID: "local-session", callID: "switch-local" },
      { args: { command: "denv local" } },
    )
    const localEnvironment = { env: {} as Record<string, string> }
    await first["shell.env"](
      { cwd: directory, sessionID: "local-session", callID: "ordinary-local-command" },
      localEnvironment,
    )
    expect(localEnvironment.env.DENV_TARGET_ENV).toBe("")
    expect(JSON.parse(readFileSync(overridesPath, "utf8"))).toEqual({
      "production-session": "production",
      "local-session": null,
    })
  })
})
