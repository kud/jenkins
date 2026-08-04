import fs from "fs"
import path from "path"
import os from "os"

// Config path: XDG (~/.config/jenkins-cli/config.json) or $XDG_CONFIG_HOME
const XDG_BASE =
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
const DIR = path.join(XDG_BASE, "jenkins-cli")
const FILE = path.join(DIR, "config.json")

export const CONFIG_FILE = FILE

interface ServerEntry {
  url?: string
  user?: string
  token?: string
}
export interface StoredConfig {
  url?: string
  user?: string
  token?: string
  current?: string
  servers?: Record<string, ServerEntry>
  __replaceServers?: boolean
} // persisted shape

interface ResolveOverrides {
  url?: string
  user?: string
  token?: string
  server?: string
  timeout?: number
  retries?: number
}

export interface JenkinsInstance {
  name: string
  url?: string
  user?: string
  token?: string
}

export const loadConfig = (): StoredConfig => {
  try {
    if (!fs.existsSync(FILE)) return {}
    let raw = fs.readFileSync(FILE, "utf8")
    // Salvage common corruption: trailing garbage after JSON
    const endIdx = raw.lastIndexOf("}")
    if (endIdx !== -1) raw = raw.slice(0, endIdx + 1)
    let parsed = JSON.parse(raw)
    // Salvage markdown style [url](url) values
    const fixLink = (v: any) =>
      typeof v === "string" && /^\[[^\]]+\]\([^\)]+\)$/.test(v)
        ? v.replace(/^\[[^\]]+\]\(([^\)]+)\)$/, "$1")
        : v
    if (parsed && typeof parsed === "object") {
      if (parsed.url) parsed.url = fixLink(parsed.url)
      if (parsed.servers) {
        for (const k of Object.keys(parsed.servers)) {
          const srv = parsed.servers[k]
          if (srv && srv.url) srv.url = fixLink(srv.url)
        }
      }
    }
    return parsed
  } catch (e) {
    return {}
  }
}

export const saveConfig = (
  cfg: Partial<StoredConfig> & { __replaceServers?: boolean },
) => {
  fs.mkdirSync(DIR, { recursive: true })
  let merged
  const existing = loadConfig()
  if (cfg.__replaceServers) {
    merged = { ...existing, servers: cfg.servers || {}, current: cfg.current }
  } else if (cfg.servers) {
    merged = {
      ...existing,
      servers: { ...(existing.servers || {}), ...cfg.servers },
    }
    if (cfg.current) merged.current = cfg.current
  } else if (cfg.url || cfg.user || cfg.token) {
    merged = { ...existing, ...cfg }
  } else {
    merged = { ...existing, ...cfg }
  }

  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2))
}

const pickServer = (file, serverName) => {
  if (!file.servers) return null
  const name = serverName || file.current || Object.keys(file.servers)[0]
  if (!name) return null
  const srv = file.servers[name]
  if (!srv) return null
  return { name, ...srv }
}

// Comma or pipe separated, same as MCP_JENKINS_* — a pipe is there because a
// token is far more likely to contain a comma than a pipe.
const splitValues = (value?: string): string[] =>
  value
    ? value
        .split(/[,|]/)
        .map((v) => v.trim())
        .filter(Boolean)
    : []

// A URL is not required to carry its own name, so this is only a fallback for
// when JENKINS_INSTANCES is unset. Naming instances explicitly is what makes
// `--server` stable when a URL changes.
const deriveName = (url: string, index: number): string => {
  try {
    return new URL(url).hostname.split(".")[0]
  } catch {
    return `instance${index + 1}`
  }
}

/**
 * Jenkins instances declared in the environment.
 *
 * Single instance:
 *   JENKINS_URL=https://jenkins.example.com
 *   JENKINS_USER=admin
 *   JENKINS_API_TOKEN=token
 *
 * Multiple (comma or pipe separated, positional):
 *   JENKINS_INSTANCES=pipeline,scheduler
 *   JENKINS_URL=https://pipeline.example.com,https://scheduler.example.com
 *   JENKINS_USER=admin,admin
 *   JENKINS_API_TOKEN=token1,token2
 *
 * A user or token list of length one applies to every instance, so a shared
 * account needs stating once. The first instance is the default.
 */
export const envInstances = (): JenkinsInstance[] => {
  const urls = splitValues(process.env.JENKINS_URL)
  if (urls.length === 0) return []

  const users = splitValues(process.env.JENKINS_USER)
  const tokens = splitValues(process.env.JENKINS_API_TOKEN)
  const names = splitValues(process.env.JENKINS_INSTANCES)

  // Refuse rather than pair them off: a short list would silently authenticate
  // one instance as another, which looks like a permissions problem on a server
  // you never meant to touch.
  if (names.length > 0 && names.length !== urls.length) {
    throw new Error(
      `JENKINS_INSTANCES has ${names.length} name(s) but JENKINS_URL has ${urls.length} — counts must match`,
    )
  }

  return urls.map((url, i) => ({
    name: names[i] ?? deriveName(url, i),
    url: url.replace(/\/$/, ""),
    user: users[i] ?? users[0],
    token: tokens[i] ?? tokens[0],
  }))
}

/** Every instance the environment and the config file know about, env winning by name. */
export const listInstances = (): JenkinsInstance[] => {
  const file = loadConfig()
  const merged = new Map<string, JenkinsInstance>()
  for (const [name, srv] of Object.entries(file.servers || {}))
    merged.set(name, { name, ...srv })
  for (const inst of envInstances()) merged.set(inst.name, inst)
  return Array.from(merged.values())
}

export const resolveConfig = (
  overrides: ResolveOverrides = {},
): StoredConfig => {
  const rawEnv = {
    server: process.env.JENKINS_SERVER,
    timeout: process.env.JENKINS_TIMEOUT
      ? parseInt(process.env.JENKINS_TIMEOUT, 10)
      : undefined,
    retries: process.env.JENKINS_RETRIES
      ? parseInt(process.env.JENKINS_RETRIES, 10)
      : undefined,
  }
  // Only include env vars that are non-empty (avoid overriding file values with empty strings)
  const env = Object.fromEntries(
    Object.entries(rawEnv).filter(([_, v]) => v !== undefined && v !== ""),
  )
  const file = loadConfig()
  const wanted = (overrides as any).server || (env as any).server

  let base: any = {}
  const instances = envInstances()
  if (instances.length > 0) {
    const chosen = wanted
      ? instances.find((i) => i.name === wanted)
      : instances[0]
    // A named instance that the environment doesn't define may still be a stored
    // server, so fall through rather than failing here.
    if (chosen)
      base = { url: chosen.url, user: chosen.user, token: chosen.token }
  }

  if (!base.url) {
    if (file.servers) {
      const srv = pickServer(file, wanted)
      if (srv) base = { url: srv.url, user: srv.user, token: srv.token }
    } else {
      base = { url: file.url, user: file.user, token: file.token }
    }
  }

  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([_, v]) => v !== undefined),
  )
  return { ...base, ...env, ...cleanOverrides }
}

export const addServer = (name, { url, user, token }) => {
  const file = loadConfig()
  const servers = { ...(file.servers || {}) }
  servers[name] = { url, user, token }
  const current = file.current || name
  saveConfig({ ...file, servers, current })
}

export const useServer = (name) => {
  const file = loadConfig()
  if (!file.servers || !file.servers[name])
    throw new Error(`Server '${name}' not found`)
  saveConfig({ ...file, current: name })
}

export const removeServer = (name) => {
  const file = loadConfig()
  if (!file.servers || !file.servers[name])
    throw new Error(`Server '${name}' not found`)
  const servers = { ...file.servers }
  delete servers[name]
  let current = file.current
  if (current === name) current = Object.keys(servers)[0]
  saveConfig({ ...file, servers, current, __replaceServers: true })
}

export const listServers = () => {
  const file = loadConfig()
  const list = Object.entries(file.servers || {}).map(([name, v]) => ({
    name,
    ...v,
    current: file.current === name,
  }))
  return list
}
