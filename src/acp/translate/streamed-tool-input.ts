/**
 * Incremental reader for the tool-call arguments pi streams as `toolcall_delta`
 * fragments.
 *
 * pi's rpc mode strips the partial assistant message from every event (see
 * `toJsonEvent` in pi-coding-agent), so a delta carries only `contentIndex` and
 * a raw JSON fragment — no tool id, no name, and nothing parseable until the
 * object closes. Writing a large file therefore streams for as long as the
 * model takes while the client hears nothing about the call.
 *
 * The scanner keeps just enough JSON awareness (string/escape state, nesting
 * depth) to spot commas at the top level of the arguments object: everything
 * before such a comma is a set of complete fields that can be parsed by closing
 * the object at that boundary. Modeled on claude-agent-acp's
 * `scanStreamedToolInput`.
 */
export type StreamedToolInput = {
  /** ACP tool call id minted for this stream; pi's real id is aliased to it later. */
  toolCallId: string
  partialJson: string
  /** Offset already scanned, so each delta only scans the fragment it appended. */
  scannedTo: number
  inString: boolean
  escaped: boolean
  objectDepth: number
  arrayDepth: number
  /** Offset of the most recent top-level comma (-1 before the first). */
  lastTopLevelComma: number
  /** Comma offset the last recovery was sliced at, so a boundary fires once. */
  recoveredThroughComma: number
  /** Set once the arguments object closes; pi's `toolcall_end` supplies the rest. */
  complete: boolean
  /** Whether a `tool_call` has been emitted for this stream yet. */
  opened: boolean
}

export function createStreamedToolInput(toolCallId: string): StreamedToolInput {
  return {
    toolCallId,
    partialJson: '',
    scannedTo: 0,
    inString: false,
    escaped: false,
    objectDepth: 0,
    arrayDepth: 0,
    lastTopLevelComma: -1,
    recoveredThroughComma: -1,
    complete: false,
    opened: false
  }
}

/** Append a `toolcall_delta` fragment and advance the scanner over it. */
export function appendStreamedToolInput(state: StreamedToolInput, delta: string): void {
  if (!delta) return
  state.partialJson += delta

  for (let index = state.scannedTo; index < state.partialJson.length; index += 1) {
    const character = state.partialJson[index]

    if (state.inString) {
      if (state.escaped) state.escaped = false
      else if (character === '\\') state.escaped = true
      else if (character === '"') state.inString = false
      continue
    }

    if (character === '"') state.inString = true
    else if (character === '{') state.objectDepth += 1
    else if (character === '}') {
      state.objectDepth -= 1
      if (state.objectDepth === 0) state.complete = true
    } else if (character === '[') state.arrayDepth += 1
    else if (character === ']') state.arrayDepth -= 1
    else if (character === ',' && state.objectDepth === 1 && state.arrayDepth === 0) {
      state.lastTopLevelComma = index
    }
  }

  state.scannedTo = state.partialJson.length
}

/**
 * The complete top-level fields streamed so far, or undefined when no new field
 * has landed since the last call (or the object already closed, in which case
 * `toolcall_end` carries the authoritative arguments).
 */
export function recoverStreamedToolInput(state: StreamedToolInput): Record<string, unknown> | undefined {
  if (state.complete) return undefined
  if (state.lastTopLevelComma <= state.recoveredThroughComma) return undefined

  state.recoveredThroughComma = state.lastTopLevelComma

  try {
    const value: unknown = JSON.parse(`${state.partialJson.slice(0, state.lastTopLevelComma)}}`)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
