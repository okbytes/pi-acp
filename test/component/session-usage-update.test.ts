import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function usageUpdates(conn: FakeAgentSideConnection) {
  return conn.updates.filter(u => (u.update as any)?.sessionUpdate === 'usage_update').map(u => u.update as any)
}

function makeProc(stats: unknown) {
  const proc = new FakePiRpcProcess() as any
  proc.statsCalls = 0
  proc.getSessionStats = async () => {
    proc.statsCalls += 1
    return stats
  }
  return proc
}

test('PiAcpSession: emits usage_update with context + cost after the turn settles', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = makeProc({
    cost: 2.92,
    contextUsage: { tokens: 79000, contextWindow: 1000000, percent: 8 }
  })

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  void session

  proc.emit({ type: 'agent_settled' })
  await new Promise(r => setTimeout(r, 10))

  assert.deepEqual(usageUpdates(conn), [
    {
      sessionUpdate: 'usage_update',
      used: 79000,
      size: 1000000,
      cost: { amount: 2.92, currency: 'USD' }
    }
  ])
})

test('PiAcpSession: throttles mid-turn usage refreshes and skips unusable stats', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = makeProc({
    // Post-compaction shape: window known, tokens not yet.
    contextUsage: { tokens: null, contextWindow: 200000, percent: null }
  })

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'turn_end' })
  await new Promise(r => setTimeout(r, 5))
  proc.emit({ type: 'turn_end' })
  await new Promise(r => setTimeout(r, 5))

  // Nothing renderable, so nothing is emitted...
  assert.deepEqual(usageUpdates(conn), [])
  // ...and an unemitted read does not arm the throttle, so both turn_ends polled.
  assert.equal(proc.statsCalls, 2)
})

test('PiAcpSession: a failing get_session_stats never breaks the turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getSessionStats = async () => {
    throw new Error('pi get_session_stats failed')
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  await session.emitUsageUpdate()
  assert.deepEqual(usageUpdates(conn), [])
})
