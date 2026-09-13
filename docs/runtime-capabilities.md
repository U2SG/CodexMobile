# Runtime Capabilities

CodexMobile has two agent providers but three effective execution runtimes:

- Codex Desktop IPC: Codex desktop app owns or can follow a real desktop thread.
- Codex Headless: CodexMobile runs Codex in the background without a desktop owner.
- Claude CLI: CodexMobile starts `claude -p --output-format=stream-json` child processes.

Provider names are not enough to decide UI behavior. UI and service code should use route identity and capability flags instead of scattered `provider === 'claude'` checks.

## Capability Matrix

| Capability | Codex Desktop IPC | Codex Headless | Claude CLI |
| --- | --- | --- | --- |
| Start new task | Yes, or background fallback | Yes | Yes |
| Continue completed session | Yes | Yes | Yes |
| Queue next message while running | Yes | Yes | Yes |
| Interrupt running task | Yes | Yes | Yes |
| Interrupt and send new message | Yes | Yes | Yes |
| Steer / guide active task | Yes | No | No |
| Plan mode | Yes | Yes | Yes |
| Implement plan by steering active task | Yes | No | No |
| Implement plan by queueing follow-up | Yes | Yes | Yes |
| Compact conversation | No | No | Claude real sessions only |
| Generate image | Yes | Yes | No |
| Docs / Feishu workflow | Codex-oriented | Codex-oriented | Not promised |
| Git / pinned sessions / notifications | Provider independent | Provider independent | Provider independent |
| Voice handoff | Yes | Yes | Yes, but not into a running task |

## Rules

- Route identity is separate from runtime capability. `agentMeta` only decides labels and route-specific chrome; `runtimeCapabilities` decides whether a current action can steer, queue, compact, or generate images.
- "Guide current task" means appending input to a running task. Today that is only `canSteer === true`, which requires Codex Desktop IPC, a real session, and a running task.
- Claude `--resume` is not guide/steer. It starts a later turn after the current process is done.
- Headless Codex cannot append input to an already-running SDK turn. It can queue or interrupt/restart.
- Plan implementation should ask capabilities, not provider strings: steer when `canImplementPlanBySteer`, otherwise queue when `canImplementPlanByQueue`.
- Compact is Claude JSONL-specific in this fork and should not be exposed as a generic Codex capability.
- Image generation is Codex-specific unless a Claude image path is explicitly added later.
- Image generation trigger policy is layered and deterministic:
  explicit `/image`, `/img`, or `/生成图片` always routes to image generation and strips the command prefix;
  high-confidence image/edit requests auto-route;
  medium-confidence visual design requests return an in-composer confirmation card, then resend with `forceImage` or `skipImage`;
  generic continuation phrases such as "继续" or "再来" only continue image generation inside the current image-looking session.
- Image-trigger UI does not call another LLM. The server returns `requiresConfirmation` for medium-confidence intent, and the client offers "生成图片" vs. "按普通消息发送".
- `/api/status.capabilities` is the server-side static provider capability declaration. The client still recomputes runtime-sensitive fields such as `canSteer` because they depend on selected session, draft state, running state, and desktop bridge mode.

## Current Code Anchors

- Client route identity and labels: `client/src/agent-meta.js`
- Client capability model: `client/src/runtime-capabilities.js`
- Composer send button state: `client/src/send-state.js`
- Running follow-up send mode: `client/src/app/useTurnSubmission.js`
- Server provider/session capabilities: `server/agent-capabilities.js`
- Server chat orchestration: `server/chat-service.js`
- Claude process runner: `server/codex-runner.js` (`runClaudeTurn`, pending future split)
