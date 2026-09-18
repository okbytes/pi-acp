# pi-acp (ACP adapter for pi-coding-agent)

This repository implements an **Agent Client Protocol (ACP)** adapter for **pi** (`@earendil-works/pi-coding-agent`) without modifying pi.

- ACP side: **JSON-RPC 2.0 over stdio** using `@agentclientprotocol/sdk` (TypeScript)
- Pi side: spawn `pi --mode rpc` and communicate via **newline-delimited JSON** over stdio

## Architecture (MVP)

### 1 ACP session ↔ 1 pi subprocess

Pi RPC mode is effectively single-session, so the adapter maps:

- `session/new` → spawn a dedicated `pi --mode rpc` process
- `session/prompt` → send `{type:"prompt"}` to that process and stream events back as `session/update`
- `session/cancel` → send `{type:"abort"}`

### ACP server wiring (modeled after opencode)

Use `@agentclientprotocol/sdk`:

- `ndJsonStream(input, output)` to speak ACP over stdio
- `new AgentSideConnection((conn) => new PiAcpAgent(conn, config), stream)`

## Implementation constraints / decisions

- Do **not** implement ACP client-side FS/terminal delegation in MVP. Pi already reads/writes and executes locally.
- Ignore `mcpServers` for MVP (accept in params, store in session state).
- Stream all pi assistant output as ACP `agent_message_chunk` initially.
- Tool events: map pi tool execution events to ACP `tool_call` / `tool_call_update` (as text content).

## Dev workflow (to be filled once scaffold exists)

- Install deps: `npm install`
- Run in dev: `npm run dev`
- Build: `npm run build`
- Smoke test (stdio): `npm run smoke`
- Lint: `npm run lint`
- Test: `npm run test`

## Manual testing notes

Once the adapter runs, it should behave like an ACP agent on stdio.

Quick sanity test (example):

```bashN
# Send initialize request via stdin (exact fields depend on ACP SDK version)
# echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | node dist/index.js
```

For real validation, test with an ACP client (e.g. Zed external agent).

## Coding guidelines

- Keep ACP protocol handling in `src/acp/*`.
- Keep pi RPC subprocess logic in `src/pi-rpc/*`.
- Prefer small translation functions (pi event → ACP session/update) with unit tests.
- Be strict about streaming and process cleanup (handle exit, drain stdout/stderr, timeouts).
- Avoid producing unnecessary comments! Use comments sparingly to explain non-obvious decisions, not to narrate code.
- Avoid using `any` in TypeScript; prefer explicit types and interfaces. Only use `any` when absolutely necessary (e.g. for untyped external data).

## Validation

- After making code edits, run formatting before finishing the task. Use `npm run format` when it is safe to format the whole worktree; otherwise use the narrowest safe formatter command for the files you touched.
- If formatting is skipped or fails, say so explicitly in the final response.

## Source control

- **DO NOT** commit unless explicitly asked!
- When asked, **commit straight to `main` and push to `origin`.** This is a consumer fork (see
  below): `main` is the line Zed runs, and there is nothing to review a PR against. Do not create
  a topic branch, do not open a PR, and do not flag the direct-to-`main` push as a caveat — the
  only time a branch is right is when the change is being sent upstream to `svkozak/pi-acp`.

## This checkout is a patched fork

This working copy is **`okbytes/pi-acp`**, a fork of `svkozak/pi-acp` kept patched for daily
use in Zed. It is a _consumer_ fork, not a contributor fork, so the convention is inverted
from the usual advice:

- **`main` is the patched line that Zed actually runs.** Local fixes land as ordinary commits
  pushed directly to `main`. No branch, no PR, no review — those exist to coordinate between
  people, and this line has one consumer. There is no "which branch is the real one?" question.
- Upstream is a remote, not a branch to defend.

```
origin    git@github.com:okbytes/pi-acp.git     # ours; main tracks this
upstream  https://github.com/svkozak/pi-acp.git # svkozak's
```

Because `main` intentionally diverges from upstream, GitHub's "Sync fork" button does not
apply — sync by rebasing from the CLI (below). `archive/*` branches are parked experiments;
leave them alone.

### Daily loop

```bash
npm test && npm run build   # dist/ is what Zed executes and is gitignored
git add -A && git commit -m "fix(acp): ..."
git push                    # -> origin (okbytes)
```

Restart the Zed thread after a build: the agent process starts once per thread and will not
pick up a new `dist/index.js` otherwise.

### Pulling in upstream work

```bash
git fetch upstream
git rebase upstream/main    # replays local patches on top of svkozak's main
npm test && npm run build
git push --force-with-lease # rebase rewrote local commits; expected, and safe (sole pusher)
```

Keep local patches as **small, single-purpose commits**. That is what makes this rebase cheap
and lets any one of them be dropped when upstream fixes the same thing.

### Contributing a patch upstream

Cut a topic branch from upstream and cherry-pick, so the PR carries only that change:

```bash
git switch -c fix/whatever upstream/main
git cherry-pick <sha>
git push -u origin fix/whatever
gh pr create --repo svkozak/pi-acp --head okbytes:fix/whatever
```

### Local patches currently carried

- **Streamed tool cards** — open a tool call card while its arguments are still streaming, since
  pi withholds the call's id/name until `toolcall_end` (`src/acp/translate/streamed-tool-input.ts`,
  plus the `message_update` handling in `src/acp/session.ts`).
- **Context/cost readout** — emit ACP `usage_update` from pi's `get_session_stats`
  (`Session.emitUsageUpdate` in `src/acp/session.ts`).
- **Compact config bar + model filtering** — model/thinking labels and
  `acp.hideModels`/`acp.showModels` + `PI_ACP_HIDE_MODELS`/`PI_ACP_SHOW_MODELS`
  (`buildConfigOptions`/`getModelState` in `src/acp/agent.ts`, `getAcpModelFilter` in
  `src/acp/pi-settings.ts`).
- **Opt-in update notice** — the "New version available" prelude is off unless
  `acp.updateNotice` / `PI_ACP_UPDATE_NOTICE=true` asks for it; npm has the version before the
  local installer can fetch it, and emitting it as the first agent message pins Zed's thread
  title to "New Agent Thread" (`getUpdateNoticeEnabled` in `src/acp/pi-settings.ts`).
- **Prompt gating on pi's own turns** — a pi extension can start a turn the adapter never asked
  for (`pi.sendUserMessage`/`pi.sendMessage`, as `continue-after-compaction` does after every
  compaction). Gating only on `pendingTurn` let the next user prompt reach pi mid-turn, where pi
  answers `success:false, "Agent is already processing"` and the message was silently dropped
  while the ACP turn resolved `end_turn`. Prompts now gate on `piIsBusy()` and a busy rejection
  is requeued rather than resolved away (`piIsBusy`/`drainQueue`/`requeueRejectedTurn` in
  `src/acp/session.ts`).
- **Turn ends when pi dies** — `PiRpcProcess` only rejected in-flight RPC requests on child exit,
  and the prompt RPC resolves at acceptance, so a pi that died mid-turn left `session/prompt`
  open forever. The process now reports its exit and the session ends the turn with a notice
  (`PiRpcProcess.onExit` in `src/pi-rpc/process.ts`, `Session.handlePiExit`).

Rebase conflicts, when they happen, are almost always in `getModelState`/`buildConfigOptions`
in `src/acp/agent.ts`, the pi-event `switch` in `src/acp/session.ts`, or the `prompt`/`startTurn`
pair next to it — the hot spots upstream edits.

## Client information

- Current ACP client is Zed
- Zed launches this checkout directly: `"agent_servers": { "pi-acp": { "command": "node",
"args": ["/Users/brett/code/pi-acp/dist/index.js" ] } }` in `~/.config/zed/settings.json`,
  which is chezmoi-managed (`~/.local/share/chezmoi/dot_config/zed/private_settings.json.tmpl`).
  Edit the chezmoi source and `chezmoi apply`, never the generated file.

## References

- ACP TypeScript SDK types/schema (authoritative for what a client will accept):
  `node_modules/@agentclientprotocol/sdk/schema/schema.json` and `dist/schema/types.gen.d.ts`
- pi's RPC command/response reference (authoritative for the pi side): `docs/rpc.md` inside the
  installed `@earendil-works/pi-coding-agent` package
- Reference implementation of a mature ACP adapter: `~/code/claude-agent-acp`
- Upstream-author paths (may not exist on this machine): `~/Dev/learning/agent-client-protocol`,
  `~/Dev/learning/zed/zed`
