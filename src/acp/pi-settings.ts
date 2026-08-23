import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function isObject(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x)
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const av = out[k]
    if (isObject(av) && isObject(v)) out[k] = deepMerge(av, v)
    else out[k] = v
  }
  return out
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    const raw = readFileSync(path, 'utf-8')
    const data = JSON.parse(raw)
    return isObject(data) ? data : {}
  } catch {
    return {}
  }
}

function getMergedSettings(cwd: string): Record<string, unknown> {
  const globalSettingsPath = join(getAgentDir(), 'settings.json')
  const projectSettingsPath = resolve(cwd, '.pi', 'settings.json')

  const global = readJsonFile(globalSettingsPath)
  const project = readJsonFile(projectSettingsPath)
  return deepMerge(global, project)
}

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

/**
 * Mirror pi settings semantics (global + project merge, project overrides global).
 * Only returns the bits we currently need.
 */
export function getEnableSkillCommands(cwd: string): boolean {
  const merged = getMergedSettings(cwd)

  const direct = merged.enableSkillCommands
  if (typeof direct === 'boolean') return direct

  // Back-compat: some versions used skills.enableSkillCommands
  const nested = isObject(merged.skills) ? merged.skills.enableSkillCommands : undefined
  if (typeof nested === 'boolean') return nested

  return true
}

export type AcpModelFilter = {
  hide: string[]
  show: string[]
}

function toPatternList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
  if (typeof value === 'string')
    return value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  return []
}

/**
 * Model visibility filter for the ACP model picker.
 *
 * Sources (merged, later wins for env):
 *   ~/.pi/agent/settings.json / <cwd>/.pi/settings.json:
 *     { "acp": { "hideModels": ["google-vertex/*"], "showModels": [] } }
 *   env: PI_ACP_HIDE_MODELS="google-vertex/*,*gemini*"  PI_ACP_SHOW_MODELS="anthropic-vertex/*"
 *
 * Patterns are case-insensitive globs (`*` = any run of characters) matched against
 * "provider/id", the bare id, the bare provider, and the human model name.
 */
export function getAcpModelFilter(cwd: string): AcpModelFilter {
  const merged = getMergedSettings(cwd)
  const acp = isObject(merged.acp) ? merged.acp : {}

  const hide = [...toPatternList(acp.hideModels), ...toPatternList(process.env.PI_ACP_HIDE_MODELS)]
  const show = [...toPatternList(acp.showModels), ...toPatternList(process.env.PI_ACP_SHOW_MODELS)]

  return { hide, show }
}

/**
 * Mirror pi's quietStartup setting: if true, pi suppresses the verbose startup prelude.
 * We use it to decide whether to synthesize + emit our own "startup info" message.
 */
export function getQuietStartup(cwd: string): boolean {
  const merged = getMergedSettings(cwd)

  const direct = merged.quietStartup
  if (typeof direct === 'boolean') return direct

  // Back-compat: some versions used quietStart
  const legacy = (merged as any).quietStart
  if (typeof legacy === 'boolean') return legacy

  return false
}
