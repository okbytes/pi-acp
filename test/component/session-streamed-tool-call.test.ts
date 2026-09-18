import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Event shapes here mirror `pi --mode rpc` exactly: pi strips the partial
// assistant message from rpc events, so `toolcall_start` and `toolcall_delta`
// carry a contentIndex and a raw JSON fragment and nothing else, and the tool's
// id and name arrive only with `toolcall_end`.
function newSession(cwd: string) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  return { conn, proc }
}

function toolEvent(assistantMessageEvent: Record<string, unknown>) {
  return { type: 'message_update', assistantMessageEvent }
}

const settle = () => new Promise(r => setTimeout(r, 0))

test('PiAcpSession: opens a card while a long tool call is still streaming', async () => {
  const { conn, proc } = newSession(process.cwd())

  proc.emit(toolEvent({ type: 'toolcall_start', contentIndex: 0 }))
  proc.emit(toolEvent({ type: 'toolcall_delta', contentIndex: 0, delta: '' }))
  proc.emit(toolEvent({ type: 'toolcall_delta', contentIndex: 0, delta: '{"path": "poem.md", "content": "' }))
  await settle()

  assert.equal(conn.updates.length, 0, 'nothing yet: a short call would finish before a placeholder helps')

  proc.emit(toolEvent({ type: 'toolcall_delta', contentIndex: 0, delta: 'a line of verse\\n'.repeat(40) }))
  await settle()

  assert.equal(conn.updates.length, 1)
  const opened = conn.updates[0]!.update as any
  assert.equal(opened.sessionUpdate, 'tool_call')
  assert.equal(opened.status, 'pending')
  assert.deepEqual(opened.rawInput, { path: 'poem.md' })
  assert.deepEqual(opened.locations, [{ path: join(process.cwd(), 'poem.md') }])
})

test('PiAcpSession: names the streamed card and keeps pi execution on the same card', async () => {
  const { conn, proc } = newSession(process.cwd())
  const content = 'a line of verse\n'.repeat(40)

  proc.emit(toolEvent({ type: 'toolcall_start', contentIndex: 0 }))
  proc.emit(toolEvent({ type: 'toolcall_delta', contentIndex: 0, delta: '{"path": "poem.md", "content": "' }))
  proc.emit(toolEvent({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(content).slice(1, -1) }))
  await settle()

  const toolCallId = (conn.updates[0]!.update as any).toolCallId
  assert.ok(toolCallId, 'card opened under an adapter-minted id')

  proc.emit(
    toolEvent({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { type: 'toolCall', id: 'toolu_vrtx_01', name: 'write', arguments: { path: 'poem.md', content } }
    })
  )
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'toolu_vrtx_01',
    toolName: 'write',
    args: { path: 'poem.md', content }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'toolu_vrtx_01',
    toolName: 'write',
    result: { content: [{ type: 'text', text: 'Successfully wrote 640 bytes to poem.md' }] },
    isError: false
  })
  await settle()

  const updates = conn.updates.map(u => u.update as any)
  assert.deepEqual(
    updates.map(u => u.sessionUpdate),
    ['tool_call', 'tool_call_update', 'tool_call_update', 'tool_call_update']
  )
  assert.deepEqual(new Set(updates.map(u => u.toolCallId)), new Set([toolCallId]))
  assert.equal(updates[1]!.title, 'write')
  assert.equal(updates[1]!.kind, 'edit')
  assert.equal(updates[2]!.status, 'in_progress')
  assert.equal(updates[3]!.status, 'completed')
})

test('PiAcpSession: short tool calls keep pi ids and emit a single card', async () => {
  const { conn, proc } = newSession(process.cwd())
  const args = { path: 'tiny.txt', content: 'alpha\nbeta\ngamma\n' }

  proc.emit(toolEvent({ type: 'toolcall_start', contentIndex: 0 }))
  proc.emit(toolEvent({ type: 'toolcall_delta', contentIndex: 0, delta: '{"path": "tiny.txt", "content": "alpha' }))
  proc.emit(
    toolEvent({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { type: 'toolCall', id: 'toolu_vrtx_02', name: 'write', arguments: args }
    })
  )
  await settle()

  assert.equal(conn.updates.length, 1)
  const update = conn.updates[0]!.update as any
  assert.equal(update.sessionUpdate, 'tool_call')
  assert.equal(update.toolCallId, 'toolu_vrtx_02')
  assert.equal(update.title, 'write')
  assert.deepEqual(update.rawInput, args)
})

test('PiAcpSession: a streamed bash call still gets its terminal', async () => {
  const { conn, proc } = newSession(process.cwd())
  const command = `echo ${'x'.repeat(600)}`

  proc.emit(toolEvent({ type: 'toolcall_start', contentIndex: 0 }))
  proc.emit(toolEvent({ type: 'toolcall_delta', contentIndex: 0, delta: `{"command": "${command}` }))
  proc.emit(
    toolEvent({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { type: 'toolCall', id: 'toolu_vrtx_03', name: 'bash', arguments: { command } }
    })
  )
  await settle()

  const updates = conn.updates.map(u => u.update as any)
  assert.equal(updates[0]!.sessionUpdate, 'tool_call')
  const named = updates[1]!
  assert.equal(named.sessionUpdate, 'tool_call_update')
  assert.equal(named.toolCallId, updates[0]!.toolCallId)
  assert.equal(named.title, command)
  assert.equal(named.kind, 'execute')
  assert.deepEqual(named.content, [{ type: 'terminal', terminalId: updates[0]!.toolCallId }])
  assert.equal(named._meta.terminal_info.terminal_id, updates[0]!.toolCallId)
})

test('PiAcpSession: fails a streamed card abandoned when the message ends', async () => {
  const { conn, proc } = newSession(mkdtempSync(join(tmpdir(), 'pi-acp-abandon-')))

  proc.emit(toolEvent({ type: 'toolcall_start', contentIndex: 0 }))
  proc.emit(
    toolEvent({ type: 'toolcall_delta', contentIndex: 0, delta: `{"path": "a.txt", "content": "${'x'.repeat(600)}` })
  )
  proc.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted' } })
  await settle()

  const updates = conn.updates.map(u => u.update as any)
  assert.equal(updates.length, 2)
  assert.equal(updates[1]!.sessionUpdate, 'tool_call_update')
  assert.equal(updates[1]!.status, 'failed')
  assert.equal(updates[1]!.toolCallId, updates[0]!.toolCallId)
})

test('PiAcpSession: tracks two tool calls streaming in one message', async () => {
  const { conn, proc } = newSession(process.cwd())

  proc.emit(toolEvent({ type: 'toolcall_start', contentIndex: 0 }))
  proc.emit(toolEvent({ type: 'toolcall_start', contentIndex: 1 }))
  proc.emit(
    toolEvent({ type: 'toolcall_delta', contentIndex: 0, delta: `{"path": "one.md", "content": "${'x'.repeat(600)}` })
  )
  proc.emit(
    toolEvent({ type: 'toolcall_delta', contentIndex: 1, delta: `{"path": "two.md", "content": "${'y'.repeat(600)}` })
  )
  await settle()

  const updates = conn.updates.map(u => u.update as any)
  assert.equal(updates.length, 2)
  assert.deepEqual(updates[0]!.rawInput, { path: 'one.md' })
  assert.deepEqual(updates[1]!.rawInput, { path: 'two.md' })
  assert.notEqual(updates[0]!.toolCallId, updates[1]!.toolCallId)
})
