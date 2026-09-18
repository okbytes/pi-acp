import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(proc: FakePiRpcProcess, conn: FakeAgentSideConnection) {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function settleMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise(resolve => setImmediate(resolve))
}

function startTurnPiDidNotRequest(proc: FakePiRpcProcess): void {
  proc.emit({ type: 'agent_start' })
}

function finishPiTurn(proc: FakePiRpcProcess): void {
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
}

test('PiAcpSession: a prompt arriving during a pi-initiated turn is queued, not sent', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(proc, conn)

  startTurnPiDidNotRequest(proc)

  const turn = session.prompt('what is 2+2?')
  await settleMicrotasks()
  assert.equal(proc.prompts.length, 0)

  finishPiTurn(proc)

  await waitFor(() => proc.prompts.length === 1)
  assert.equal(proc.prompts[0]?.message, 'what is 2+2?')

  proc.emit({ type: 'agent_start' })
  finishPiTurn(proc)
  assert.equal(await turn, 'end_turn')
})

test('PiAcpSession: a prompt pi rejects while busy is retried instead of dropped', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  let busy = true
  ;(proc as any).prompt = async (message: string, attachments: unknown[] = []) => {
    if (busy) throw new Error('pi prompt failed: Agent is already processing. Specify streamingBehavior.')
    proc.prompts.push({ message, attachments })
  }

  const session = createSession(proc, conn)
  const turn = session.prompt('hello')

  await settleMicrotasks()
  assert.equal(proc.prompts.length, 0)

  busy = false
  await waitFor(() => proc.prompts.length === 1)
  assert.equal(proc.prompts[0]?.message, 'hello')

  proc.emit({ type: 'agent_start' })
  finishPiTurn(proc)
  assert.equal(await turn, 'end_turn')
})

test('PiAcpSession: pi dying mid-turn ends the turn instead of leaving it open', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(proc, conn)

  const turn = session.prompt('long running work')
  const queued = session.prompt('next one')
  proc.emit({ type: 'agent_start' })

  proc.emitExit({ code: 1, signal: null })

  assert.equal(await turn, 'error')
  assert.equal(await queued, 'error')

  const texts = conn.updates
    .map(u => (u as any).update?.content?.text)
    .filter((t): t is string => typeof t === 'string')
  assert.ok(texts.some(t => /pi exited before the turn finished/.test(t)))
})

test('PiAcpSession: a queued prompt still runs after the turn ahead of it finishes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(proc, conn)

  const first = session.prompt('one')
  const second = session.prompt('two')
  assert.equal(proc.prompts.length, 1)

  proc.emit({ type: 'agent_start' })
  finishPiTurn(proc)
  assert.equal(await first, 'end_turn')

  await waitFor(() => proc.prompts.length === 2)
  assert.equal(proc.prompts[1]?.message, 'two')

  proc.emit({ type: 'agent_start' })
  finishPiTurn(proc)
  assert.equal(await second, 'end_turn')
})
