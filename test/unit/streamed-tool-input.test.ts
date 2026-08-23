import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendStreamedToolInput,
  createStreamedToolInput,
  recoverStreamedToolInput
} from '../../src/acp/translate/streamed-tool-input.js'

test('streamed tool input: recovers complete fields at top-level commas', () => {
  const state = createStreamedToolInput('t1')

  appendStreamedToolInput(state, '{"path": "a.txt"')
  assert.equal(recoverStreamedToolInput(state), undefined)

  appendStreamedToolInput(state, ', "content": "hel')
  assert.deepEqual(recoverStreamedToolInput(state), { path: 'a.txt' })
})

test('streamed tool input: recovers a boundary only once', () => {
  const state = createStreamedToolInput('t1')

  appendStreamedToolInput(state, '{"path": "a.txt", "content": "hel')
  assert.deepEqual(recoverStreamedToolInput(state), { path: 'a.txt' })
  assert.equal(recoverStreamedToolInput(state), undefined)

  appendStreamedToolInput(state, 'lo", "mode": "w')
  assert.deepEqual(recoverStreamedToolInput(state), { path: 'a.txt', content: 'hello' })
})

test('streamed tool input: ignores commas inside strings, objects and arrays', () => {
  const state = createStreamedToolInput('t1')

  appendStreamedToolInput(state, '{"content": "one, two, three"')
  assert.equal(recoverStreamedToolInput(state), undefined)

  appendStreamedToolInput(state, ', "edits": [{"oldText": "a", "newText": "b"}]')
  assert.deepEqual(recoverStreamedToolInput(state), { content: 'one, two, three' })

  appendStreamedToolInput(state, ', "path": "a')
  assert.deepEqual(recoverStreamedToolInput(state), {
    content: 'one, two, three',
    edits: [{ oldText: 'a', newText: 'b' }]
  })
})

test('streamed tool input: tracks escapes so an escaped quote does not end the string', () => {
  const state = createStreamedToolInput('t1')

  appendStreamedToolInput(state, '{"content": "say \\"hi\\", then stop"')
  assert.equal(recoverStreamedToolInput(state), undefined)

  appendStreamedToolInput(state, ', "path": "a')
  assert.deepEqual(recoverStreamedToolInput(state), { content: 'say "hi", then stop' })
})

test('streamed tool input: a trailing escaped backslash does not swallow the closing quote', () => {
  const state = createStreamedToolInput('t1')

  appendStreamedToolInput(state, '{"content": "back\\\\"')
  appendStreamedToolInput(state, ', "path": "a')
  assert.deepEqual(recoverStreamedToolInput(state), { content: 'back\\' })
})

test('streamed tool input: stops recovering once the arguments object closes', () => {
  const state = createStreamedToolInput('t1')

  appendStreamedToolInput(state, '{"path": "a.txt", "content": "hello"}')
  assert.equal(state.complete, true)
  assert.equal(recoverStreamedToolInput(state), undefined)
})

test('streamed tool input: scans each fragment once', () => {
  const state = createStreamedToolInput('t1')

  appendStreamedToolInput(state, '{"path": "a.txt"')
  appendStreamedToolInput(state, ', "content": "hello"}')

  assert.equal(state.scannedTo, state.partialJson.length)
  assert.equal(state.complete, true)
})
