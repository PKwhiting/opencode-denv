// denv — lock individual opencode chat sessions to remote droplets.
//
// One opencode instance, many chat sessions, each pinned to its own droplet.
// A session picks its environment by its TITLE: title a session so it contains
// a configured env name (e.g. "dev1"), and every shell command in that session
// is routed to that droplet over SSH. Sessions whose title matches no
// env behave normally (local) — unless DENV_STRICT=1, which denies them.
//
// Config: ~/.config/opencode/denv-envs.json
//   { "dev1": { "host": "root@1.2.3.4", "workspace": "/" }, ... }
//
// Why shell-only: the shell.env hook can route the built-in shell executor while
// preserving the command shown to the agent. File tools still cannot be redirected
// to a remote, so bound sessions deny them and use the remote shell instead.

import type { Plugin } from "@opencode-ai/plugin"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const HOME = homedir()
const ENVS_PATH =
  process.env.DENV_ENVS || join(HOME, ".config", "opencode", "denv-envs.json")
const SESSION_ENVS_PATH =
  process.env.DENV_SESSION_ENVS || join(HOME, ".config", "opencode", "denv-session-envs.json")
const STRICT = process.env.DENV_STRICT === "1"
// The helper used by denv-terminal-shell for remote execution. Keep it absolute
// by default so the adapter resolves it regardless of opencode's shell PATH.
const DENV_RUN =
  process.env.DENV_RUN || join(HOME, ".config", "opencode", "denv-run")

const FILE_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "patch",
  "grep",
  "glob",
  "list",
])
const LOCAL_SHELL_CALLS = new Set<string>()

type Env = { host: string; workspace?: string }
type SessionEnvOverride = string | null
type SessionInfo = {
  title?: string
  parentID?: string
}

export type DenvSessionCommand =
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "reset" }
  | { kind: "use"; env: string | null }
  | { kind: "unknown"; env: string }

function loadEnvs(): Record<string, Env> {
  try {
    const raw = JSON.parse(readFileSync(ENVS_PATH, "utf8"))
    delete (raw as Record<string, unknown>)._comment
    return raw
  } catch {
    return {}
  }
}

function loadSessionEnvOverrides(): Record<string, SessionEnvOverride> {
  try {
    const raw = JSON.parse(readFileSync(SESSION_ENVS_PATH, "utf8"))
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
    const entries = Object.entries(raw).filter(
      (entry): entry is [string, SessionEnvOverride] => typeof entry[1] === "string" || entry[1] === null,
    )
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

function saveSessionEnvOverrides(overrides: Record<string, SessionEnvOverride>): void {
  mkdirSync(dirname(SESSION_ENVS_PATH), { recursive: true })
  writeFileSync(SESSION_ENVS_PATH, `${JSON.stringify(overrides, null, 2)}\n`, "utf8")
}

// POSIX single-quote a string so it becomes one safe shell argument.
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Reverse of shSingleQuote's inner escaping: turn '\'' back into '.
export function shSingleUnquote(inner: string): string {
  return inner.replace(/'\\''/g, "'")
}

export function selectEnvForTitle(
  title: string,
  names: readonly string[],
): string | null {
  const normalizedTitle = title.toLowerCase()
  let match: string | null = null
  for (const name of names) {
    if (
      normalizedTitle.includes(name.toLowerCase()) &&
      (match === null || name.length > match.length)
    ) {
      match = name
    }
  }
  return match
}

export function selectEnvByName(input: string, names: readonly string[]): string | null {
  const normalized = input.toLowerCase()
  return names.find((name) => name.toLowerCase() === normalized) ?? null
}

export function parseDenvSessionCommand(cmd: string, names: readonly string[]): DenvSessionCommand | null {
  const withoutComment = cmd.trim().replace(/\s+#.*$/, "")
  const parts = withoutComment
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.replace(/^(['"])(.*)\1$/, "$2"))
  const executable = parts[0] ?? ""
  const executableName = executable.replace(/\\/g, "/").split("/").pop()
  if (executableName !== "denv") return null
  if (parts.includes("--help") || parts.includes("-h")) return { kind: "list" }
  const action = (parts[1] ?? "status").toLowerCase()

  if (parts.length === 1) return { kind: "status" }
  if (parts.length === 2) {
    if (action === "status" || action === "env" || action === "--status") {
      return { kind: "status" }
    }
    if (action === "list" || action === "ls" || action === "help" || action === "--help" || action === "-h") {
      return { kind: "list" }
    }
    if (action === "reset" || action === "title") return { kind: "reset" }
    if (action === "local" || action === "--local") return { kind: "use", env: null }
    if (action === "use" || action === "switch") return { kind: "list" }

    const directEnvironment = selectEnvByName(action, names)
    if (directEnvironment) return { kind: "use", env: directEnvironment }
  }

  if ((action === "use" || action === "switch") && parts.length === 3) {
    const requested = parts[2]
    if (requested.toLowerCase() === "local" || requested.toLowerCase() === "--local") {
      return { kind: "use", env: null }
    }
    return { kind: "use", env: selectEnvByName(requested, names) ?? requested }
  }

  return { kind: "unknown", env: action }
}

// Compatibility for commands copied from transcripts produced before transport
// forwarding became hidden. Peel the wrapper back off so it cannot be nested.
// Handles bare and absolute-path forms and loops a few times for accidental
// double/triple wraps. Only matches when the WHOLE command is a single wrapper,
// so a benign `cat denv-run` etc. is left alone.
export function stripSelfWrap(cmd: string): string {
  let out = cmd.trim()
  const re = /^\S*denv-run\s+\S+\s+'([\s\S]*)'$/
  for (let i = 0; i < 5; i++) {
    const m = out.match(re)
    if (!m) break
    out = shSingleUnquote(m[1]).trim()
  }
  return out
}

function localPrint(message: string): string {
  return `printf '%s\\n' ${shSingleQuote(message)}`
}

export const DenvPlugin: Plugin = async ({ client }) => {
  const envs = loadEnvs()
  const names = Object.keys(envs)
  const cache = new Map<string, string | null>() // sessionID -> env name | null
  const sessionInfoCache = new Map<string, SessionInfo>()

  function overrideFor(
    overrides: Readonly<Record<string, SessionEnvOverride>>,
    sessionID: string,
  ): SessionEnvOverride | undefined {
    if (!Object.prototype.hasOwnProperty.call(overrides, sessionID)) return undefined
    return overrides[sessionID] ?? null
  }

  function setOverride(sessionID: string, env: SessionEnvOverride): void {
    const overrides = loadSessionEnvOverrides()
    overrides[sessionID] = env
    saveSessionEnvOverrides(overrides)
  }

  function clearOverride(sessionID: string): void {
    const overrides = loadSessionEnvOverrides()
    delete overrides[sessionID]
    saveSessionEnvOverrides(overrides)
  }

  async function sessionInfo(sessionID: string): Promise<SessionInfo | null> {
    const cached = sessionInfoCache.get(sessionID)
    if (cached) return cached
    try {
      const resp = (await client.session.get({
        path: { id: sessionID },
      })) as { data?: SessionInfo; title?: string; parentID?: string }
      const info = resp?.data ?? { title: resp?.title, parentID: resp?.parentID }
      sessionInfoCache.set(sessionID, info)
      return info
    } catch {
      return null
    }
  }

  async function inheritedOverride(
    sessionID: string,
    overrides: Readonly<Record<string, SessionEnvOverride>>,
    visited: Set<string> = new Set(),
  ): Promise<{ found: boolean; env: SessionEnvOverride }> {
    if (visited.has(sessionID)) return { found: false, env: null }
    visited.add(sessionID)

    const own = overrideFor(overrides, sessionID)
    if (own !== undefined) return { found: true, env: own }

    const info = await sessionInfo(sessionID)
    if (!info?.parentID) return { found: false, env: null }
    return inheritedOverride(info.parentID, overrides, visited)
  }

  function envList(): string {
    return names.map((name) => {
      const cfg = envs[name]
      return `- ${name} (${cfg.host}:${cfg.workspace || "/"})`
    }).join("\n")
  }

  async function envStatus(sessionID: string): Promise<string> {
    const overrides = loadSessionEnvOverrides()
    const override = await inheritedOverride(sessionID, overrides)
    if (override.found) {
      const source = overrideFor(overrides, sessionID) !== undefined ? "session override" : "parent session override"
      return override.env ? `denv: using ${override.env} (${source})` : `denv: using local (${source})`
    }
    const env = await resolveEnvFromTitle(sessionID)
    return env ? `denv: using ${env} (session title)` : "denv: using local (no session match)"
  }

  async function applyDenvCommand(sessionID: string, command: DenvSessionCommand): Promise<string> {
    if (command.kind === "list") return `denv environments:\n${envList()}\n\nUse: denv use <env>, denv local, denv reset, denv status`
    if (command.kind === "status") return await envStatus(sessionID)
    if (command.kind === "reset") {
      clearOverride(sessionID)
      return `${await envStatus(sessionID)}\nOverride cleared; routing is back to session title matching.`
    }
    if (command.kind === "unknown") {
      return `denv: unknown environment or command '${command.env}'.\nAvailable environments:\n${envList()}`
    }
    if (command.env === null) {
      setOverride(sessionID, null)
      return "denv: session now uses local shell tools. Run 'denv reset' to return to title matching."
    }
    const env = selectEnvByName(command.env, names)
    if (!env) return `denv: unknown environment '${command.env}'.\nAvailable environments:\n${envList()}`
    setOverride(sessionID, env)
    return `denv: session now uses ${env} (${envs[env].host}:${envs[env].workspace || "/"}).`
  }

  async function resolveEnvFromTitle(sessionID: string): Promise<string | null> {
    if (cache.has(sessionID)) return cache.get(sessionID) ?? null
    const info = await sessionInfo(sessionID)
    if (!info) return null // can't resolve yet; don't cache, retry on next call
    const title = String(info.title ?? "").toLowerCase()
    // Longest configured env name appearing in the title wins.
    const match = selectEnvForTitle(title, names) ??
      (info.parentID ? await resolveEnvFromTitle(info.parentID) : null)
    cache.set(sessionID, match)
    return match
  }

  async function resolveEnv(sessionID: string): Promise<string | null> {
    const override = await inheritedOverride(sessionID, loadSessionEnvOverrides())
    const match = override.found ? override.env : await resolveEnvFromTitle(sessionID)
    try {
      await client.app.log({
        body: {
          service: "denv",
          level: "info",
          message: `session ${sessionID} -> ${match ?? "(local)"}`,
        },
      })
    } catch {
      /* logging is best-effort */
    }
    return match
  }

  return {
    // Tell the model which environment is active without exposing the transport
    // command. Shell execution is routed by the shell.env hook below.
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system?: string[] },
    ) => {
      try {
        const sessionID = input?.sessionID
        if (!sessionID || !Array.isArray(output?.system)) return
        const env = await resolveEnv(sessionID)
        const controls =
          names.length > 0
            ? `Switch routing for this chat by submitting a bash command: \`denv use <env>\`, ` +
              `\`denv local\`, \`denv reset\`, \`denv status\`, or \`denv list\`. ` +
              `Available environments: ${names.join(", ")}.`
            : ""
        if (!env) {
          if (controls) output.system.push(`<denv-environment>\n${controls}\n</denv-environment>`)
          return
        }
        const cfg = envs[env]
        output.system.push(
          `<denv-environment>\n` +
            `You are operating INSIDE the remote environment "${env}" (${cfg.host}); ` +
            `every shell command already runs there. Submit only ordinary shell commands; ` +
            `the transport is handled automatically and is not part of the command. ` +
            `Never type "denv-run", "ssh", or "${cfg.host}" yourself. ` +
            `The file tools (read/write/edit/grep/glob/list) are disabled here, so inspect ` +
            `and edit files with shell commands (cat, sed, ls, grep). ` +
            `Default working directory: ${cfg.workspace || "/"}. ${controls}\n` +
            `</denv-environment>`,
        )
      } catch {
        /* best-effort; tool.execute.before still enforces routing */
      }
    },

    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ) => {
      if (input.tool === "bash") {
        const submitted = String(output.args.command ?? "")
        const raw = stripSelfWrap(submitted)
        const denvCommand = parseDenvSessionCommand(raw, names)
        if (denvCommand) {
          const result = await applyDenvCommand(input.sessionID, denvCommand)
          LOCAL_SHELL_CALLS.add(input.callID)
          output.args.command = localPrint(result)
          return
        }

        // Recover from commands copied from older transcripts without exposing
        // the transport wrapper for new commands.
        if (submitted !== raw) output.args.command = raw

        const env = await resolveEnv(input.sessionID)
        if (!env) {
          if (STRICT) {
            throw new Error(
              `denv: this session isn't bound to an environment. Run \`denv use <env>\` or title it after one of: ${names.join(", ")}.`,
            )
          }
          return // not a denv session -> normal local behavior
        }

        const cfg = envs[env]
        // A raw self-targeting `ssh` can't be unwrapped reliably, so still block
        // it — otherwise it nests ssh and fails with "Permission denied
        // (publickey)".
        const hostPart = cfg.host.includes("@") ? cfg.host.split("@")[1] : cfg.host
        if (/^\s*ssh\b/.test(raw) || (/\bssh\b/.test(raw) && raw.includes(hostPart))) {
          throw new Error(
            `denv: you're already inside '${env}' (${cfg.host}). Don't ssh back ` +
              `into it — just submit the plain command (e.g. \`ls /root\`).`,
          )
        }

        return
      }

      const env = await resolveEnv(input.sessionID)

      if (!env) {
        if (STRICT) {
          throw new Error(
            `denv: this session isn't bound to an environment. Run \`denv use <env>\` or title it after one of: ${names.join(", ")}.`,
          )
        }
        return // not a denv session -> normal local behavior
      }

      const cfg = envs[env]

      if (FILE_TOOLS.has(input.tool)) {
        throw new Error(
          `denv: '${input.tool}' is disabled in remote session '${env}'. ` +
            `Use shell commands (cat/sed/ls/grep) — they run on ${cfg.host}.`,
        )
      }
      // MCP, webfetch, websearch, etc. run locally, untouched.
    },

    // Route OpenCode's built-in shell executor without mutating its command
    // arguments. denv-terminal-shell consumes these variables locally and
    // invokes denv-run only inside the execution boundary.
    "shell.env": async (
      input: { cwd: string; sessionID?: string; callID?: string },
      output: { env: Record<string, string> },
    ) => {
      const callID = input.callID
      if (callID && LOCAL_SHELL_CALLS.delete(callID)) {
        output.env.DENV_TARGET_ENV = ""
        return
      }

      const env = input.sessionID ? await resolveEnv(input.sessionID) : null
      output.env.DENV_TARGET_ENV = env ?? ""
      output.env.DENV_ENVS = ENVS_PATH
      output.env.DENV_RUN = DENV_RUN
    },

    "tool.execute.after": async (input: { callID: string }) => {
      LOCAL_SHELL_CALLS.delete(input.callID)
    },
  }
}

export default {
  id: "opencode-denv",
  server: DenvPlugin,
} satisfies { id: string; server: Plugin }
