// denv — lock individual opencode chat sessions to remote droplets.
//
// One opencode instance, many chat sessions, each pinned to its own droplet.
// A session picks its environment by its TITLE: title a session so it contains
// a configured env name (e.g. "dev1"), and every shell command in that session
// is rewritten to run on that droplet over SSH. Sessions whose title matches no
// env behave normally (local) — unless DENV_STRICT=1, which denies them.
//
// Config: ~/.config/opencode/denv-envs.json
//   { "dev1": { "host": "root@1.2.3.4", "workspace": "/" }, ... }
//
// Why bash-only: the hook can rewrite a command but can't redirect opencode's
// file tools to a remote, so on a bound session those are denied and the agent
// does file work through the (remote) shell. MCP/web tools run locally as usual.

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
// The helper that actually SSHes. Absolute path by default so it resolves
// regardless of opencode's bash PATH; set DENV_RUN to just "denv-run" if you've
// put it on PATH and prefer a shorter command display.
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
  const parts = cmd.trim().split(/\s+/).filter(Boolean)
  if (parts[0] !== "denv") return null
  const action = (parts[1] ?? "status").toLowerCase()

  if (parts.length === 1 || action === "status" || action === "env") return { kind: "status" }
  if (action === "list" || action === "ls") return { kind: "list" }
  if (action === "reset" || action === "title") return { kind: "reset" }
  if (action === "local") return { kind: "use", env: null }

  if (action === "use") {
    const requested = parts[2]
    if (!requested) return { kind: "list" }
    if (requested.toLowerCase() === "local") return { kind: "use", env: null }
    return { kind: "use", env: selectEnvByName(requested, names) ?? requested }
  }

  return { kind: "unknown", env: action }
}

// If the agent re-wrapped its command in our own helper — which it does because
// it sees its commands rendered as `denv-run <env> '...'` and imitates that form
// on later turns — peel the wrapper back off so we don't double-wrap. Handles
// the bare and absolute-path forms, and any typed env name (routing is by
// session title, so a name the agent types is ignored). Loops a few times to
// undo accidental double/triple wraps. Only matches when the WHOLE command is a
// single wrapper, so a benign `cat denv-run` etc. is left alone.
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
  const overrides = loadSessionEnvOverrides() // sessionID -> env name | null for local
  const sessionInfoCache = new Map<string, SessionInfo>()

  function overrideFor(sessionID: string): SessionEnvOverride | undefined {
    if (!Object.prototype.hasOwnProperty.call(overrides, sessionID)) return undefined
    return overrides[sessionID] ?? null
  }

  function setOverride(sessionID: string, env: SessionEnvOverride): void {
    overrides[sessionID] = env
    saveSessionEnvOverrides(overrides)
  }

  function clearOverride(sessionID: string): void {
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
    visited: Set<string> = new Set(),
  ): Promise<{ found: boolean; env: SessionEnvOverride }> {
    if (visited.has(sessionID)) return { found: false, env: null }
    visited.add(sessionID)

    const own = overrideFor(sessionID)
    if (own !== undefined) return { found: true, env: own }

    const info = await sessionInfo(sessionID)
    if (!info?.parentID) return { found: false, env: null }
    return inheritedOverride(info.parentID, visited)
  }

  function envList(): string {
    return names.map((name) => {
      const cfg = envs[name]
      return `- ${name} (${cfg.host}:${cfg.workspace || "/"})`
    }).join("\n")
  }

  async function envStatus(sessionID: string): Promise<string> {
    const override = await inheritedOverride(sessionID)
    if (override.found) {
      const source = overrideFor(sessionID) !== undefined ? "session override" : "parent session override"
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
    const override = await inheritedOverride(sessionID)
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
    // Guard #1: tell the model, every turn, that it's already inside the
    // environment — so it never tries to ssh in the first place. Only fires
    // for bound sessions; others are left untouched. (experimental hook.)
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
            `every bash command already runs there. After you submit a command it is ` +
            `AUTOMATICALLY wrapped (you'll see it displayed as \`denv-run ${env} '...'\`) — ` +
            `that happens on its own, AFTER you submit. Submit ONLY the plain command. ` +
            `Never type "denv-run", "ssh", or "${cfg.host}" yourself; such commands are ` +
            `rejected. Correct: \`ls /root\`  —  Wrong: \`denv-run ${env} 'ls /root'\`. ` +
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
        const raw = stripSelfWrap(String(output.args.command ?? ""))
        const denvCommand = parseDenvSessionCommand(raw, names)
        if (denvCommand) {
          output.args.command = localPrint(await applyDenvCommand(input.sessionID, denvCommand))
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
        // The session is already inside the droplet. If the agent re-wrapped its
        // command in our own helper (it imitates the `denv-run <env> '...'` form
        // it sees rendered in its history), peel the wrapper back off instead of
        // erroring. Erroring just makes it loop: its transcript still shows
        // wrapped commands that ran fine, so it keeps reproducing the wrapper and
        // thrashing against the rejection. Unwrapping makes the rewrite
        // idempotent — plain or self-wrapped, exactly one wrap runs.
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

        // Rewrite to the clean helper; it does the SSH internally so the agent
        // never sees (and never fights) a raw ssh wrapper.
        output.args.command = `${DENV_RUN} ${env} ${shSingleQuote(raw)}`
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
  }
}

export default {
  id: "opencode-denv",
  server: DenvPlugin,
} satisfies { id: string; server: Plugin }
