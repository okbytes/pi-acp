import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  async create() {
    return this.session
  }
  maybeGet(sessionId: string) {
    return sessionId === this.session.sessionId ? this.session : undefined
  }
  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) throw new Error(`Unknown sessionId: ${sessionId}`)
    return this.session
  }
}

const MODELS = [
  { provider: 'google-vertex', id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1048576 },
  { provider: 'anthropic-vertex', id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1000000 },
  { provider: 'anthropic', id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1000000 },
  { provider: 'anthropic-vertex', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000 }
]

async function modelOptions(opts: { hide?: string; show?: string; current?: { provider: string; id: string } }) {
  const realSetTimeout = globalThis.setTimeout
  const prevHide = process.env.PI_ACP_HIDE_MODELS
  const prevShow = process.env.PI_ACP_SHOW_MODELS
  ;(globalThis as any).setTimeout = () => 0 as any
  if (opts.hide) process.env.PI_ACP_HIDE_MODELS = opts.hide
  else delete process.env.PI_ACP_HIDE_MODELS
  if (opts.show) process.env.PI_ACP_SHOW_MODELS = opts.show
  else delete process.env.PI_ACP_SHOW_MODELS

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: MODELS }
        },
        async getState() {
          return {
            thinkingLevel: 'high',
            model: opts.current ?? { provider: 'anthropic-vertex', id: 'claude-opus-5' }
          }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {},
      emitUsageUpdate() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
    const option = result.configOptions?.find(o => o.id === 'model') as any
    return option.options as Array<{ value: string; name: string }>
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    if (prevHide === undefined) delete process.env.PI_ACP_HIDE_MODELS
    else process.env.PI_ACP_HIDE_MODELS = prevHide
    if (prevShow === undefined) delete process.env.PI_ACP_SHOW_MODELS
    else process.env.PI_ACP_SHOW_MODELS = prevShow
  }
}

test('model picker: tightens labels and disambiguates duplicate names by provider', async () => {
  const options = await modelOptions({})

  assert.deepEqual(
    options.map(o => o.name),
    [
      'Gemini 3.5 Flash (1M context)',
      'Claude Opus 5 · anthropic-vertex (1M context)',
      'Claude Opus 5 · anthropic (1M context)',
      'Claude Haiku 4.5 (200k context)'
    ]
  )
})

test('model picker: PI_ACP_HIDE_MODELS drops whole providers', async () => {
  const options = await modelOptions({ hide: 'google-vertex/*' })

  assert.deepEqual(
    options.map(o => o.value),
    ['anthropic-vertex/claude-opus-5', 'anthropic/claude-opus-5', 'anthropic-vertex/claude-haiku-4-5']
  )
})

test('model picker: hide patterns match names too, and never hide the active model', async () => {
  const options = await modelOptions({
    hide: '*gemini*,*haiku*',
    current: { provider: 'google-vertex', id: 'gemini-3.5-flash' }
  })

  assert.deepEqual(
    options.map(o => o.value),
    ['google-vertex/gemini-3.5-flash', 'anthropic-vertex/claude-opus-5', 'anthropic/claude-opus-5']
  )
})

test('model picker: PI_ACP_SHOW_MODELS acts as an allowlist', async () => {
  const options = await modelOptions({ show: 'anthropic-vertex/*' })

  assert.deepEqual(
    options.map(o => o.value),
    ['anthropic-vertex/claude-opus-5', 'anthropic-vertex/claude-haiku-4-5']
  )
})
