# Changelog

## Unreleased

- The conversation replica no longer copies every message it holds when a page of older history is prepended (or a turn of it is updated). Each page used to cost more than the one before.
- Sending to a session restored from saved data (or bound to a stored conversation with `syncSession`) reads that conversation first, on every harness: `sendPrompt`, `run`, `steerPrompt` and `continueInterruptedTurn` all do it once, before anything is sent. A Claude conversation that another agent messaged before the app opened it now shows its earlier history with the new turn, where it showed only the new turn. If the conversation cannot be read, the prompt is rejected with that error and nothing is sent.

## 0.27.1 (2026-11-12)

- `capabilities.workPhases` says whether a harness states each text part's work phase (`commentary` or `final_answer`). Codex does; Claude, Cursor and Antigravity report assistant text exactly as the provider supplied it, with no inferred phase, so an app that groups work from the answer reads `workPhases` first. `isBookkeepingTool` is removed from `createHarness` options and from `createScriptedHarness`.
- Claude loads every turn whole, with no summary turns: its turns no longer carry `itemsView`, `detailsLoading` or `detailsError`, `capabilities.turnHistory` is not set for Claude, and `loadTurnHistory` rejects with `HarnessUnsupportedError` there. `loadOlderHistory` still pages back through a conversation, and a part that is huge on its own is still cut to a preview that `readConversationContent` reads in full.

## 0.27.0 (2026-11-12)

- Session data and conversation references name the conversation `conversationId` on every harness, replacing `sessionId` and Codex's `threadId`; Claude session data names its transcript `transcriptConversationId`, replacing `transcriptSessionId`. Data saved with the old names needs `conversationId` added before it is restored.
- `capabilities.folderScopedConversations` says whether conversations belong to a working folder, and `capabilities.subagentTranscripts` (`'inline'`, `'separate'` or `'none'`) says where a subagent's transcript can be read. References carry a `folder` or a `subagentId` only where the capabilities say so.
- `executeScopedPrompt` returns only the turn's final answer as `text` on every harness, never the commentary written along the way.
- Saved model settings (model, reasoning effort and speed) apply once when a conversation is opened on every harness. While it stays open, only an explicit selection on a prompt or `updateDefaults` changes them.
- Every harness stores and reports its permission in one field: `ProviderDefaults.permission`, `conversation.settingsUpdated` `settings.permission` and `conversation.modeUpdated` `permission`, each one of the ids in `capabilities.permissions`. Codex no longer keeps `approvalPreset`, `approvalPolicy`, `approvalsReviewer` or `sandboxMode` in stored defaults, and the other harnesses no longer keep `permissionMode`.
- Sign-in results carry the signed-in account in neutral terms: `authenticate` returns `account` (a subscription, an API key or a cloud account, with its email, plan or team where the harness reports them), and the native state and sign-in change events carry the same `account`.
- Runs whose prompts wait behind a running turn each follow their own turn, in the order the prompts were sent. A prompt sent with `sendPrompt` holds its place in that order, so a later run does not take its turn. A session whose identity was cleared with `syncSession` starts a new conversation on its next prompt on every harness. Antigravity `generateText` applies the thinking level it is asked for and rejects one the model does not offer.
- A run controls its own turn only: `steer` and `interrupt` reject once the run has ended, and while its turn has not started. A Codex prompt queued behind a running turn names no turn, so its run follows its own turn when it starts. `updateDefaults` sends the changed model, reasoning effort or speed with the next prompt, and a Codex session whose identity was cleared with `syncSession` starts a new conversation on its next prompt.
- Antigravity runs on the Antigravity CLI: the `agy` installed on the machine, version 1.5.1 or later, with every model on the account. The SDK no longer downloads a runtime; `antigravity.command` names another CLI, and `antigravity.harnessPath`, `installAcpRuntime`, `acpVersion` and `managedRuntimeDirectory` are removed. Models list once each with their thinking levels (`reasoningEffort`), plan mode is the CLI's own and hands over the plan it wrote, conversations report when they were last updated, and the permission ids are `default`, `accept-edits` and `auto`. The CLI's running thoughts stay out of the transcript, and account usage comes from the CLI's own `usage` command, without a session or a model turn.
- `tool.updated` is published once per status of a tool, however often the harness repeats it. Cursor and Antigravity report the model and permission a conversation runs with, so session state carries them on every harness. An Antigravity tool confirmation carries the `itemId` of its tool call.
- Codex runs the tools of the app's own MCP server (`trustedMcpServerName`) without approval prompts when the server is passed through `mcpServers` or a scope's `mcpServers`, as the other harnesses do.
- Claude ties an approval for a built-in tool to that tool's call instead of adding a second tool part, and an approval shown as its own part ends when it is answered. A Claude turn announces its conversation, settings and running runtime when they change, not on every message.
- Session patches send what changed inside a message: `appendPartText` for streamed text, `spliceParts` for a part that was added or replaced, and `setMessageFields` for the message's own fields. `spliceMessages` is used only when messages are added, removed or replaced, so a streaming answer no longer resends the text already sent.
- `bindSession` is removed. An app re-states what it has stored for a session with `syncSession`, which an operation already in flight sees the next time it looks.
- `capabilities.commands` lists each harness's own slash commands (compact, plan, goal), so an app can offer them without knowing the harness.
- `capabilities.safetyReview` says whether a harness stops turns on safety findings and resumes them from a safety review.
- Provider updates name their conversation in `conversationId` only; `threadId` and `providerSessionId` no longer appear on harness events.
- `./contracts` reads persisted session data for apps: `sessionConversationId`, `conversationSessionData`, `sessionConversationRef`, `sessionHasConversation`, `conversationRefId`, `sameConversationRef`, `subagentOfRef`, `subagentRef` and `isProviderSessionData`, so an app stores what a harness hands out without knowing each provider's shape.
- Each harness reads its own conversation frames into neutral activity, so shared code never interprets a provider's events. The realtime types come from one neutral module, and the root no longer exports `ContinueCodexSafetyReviewOptions` or `StartCodexRealtimeOptions` (use `RealtimeOptions`).
- `harness.run(session, prompt, options)` sends a prompt and follows its turn. `run.events` yields the session's events for that turn and ends with its `turn.completed`; `run.result` gives the turn's status, error and messages. A turn the provider retries keeps the run going. The result rejects when the prompt is not admitted, the session needs recovery, or the session is released or the harness closed first. `run.steer` and `run.interrupt` act on the run's turn. Run events leave out `session.changed`; patches carry each change. `sendPrompt` and `onEvent` are unchanged.
- `createHarness(provider, options)` is the only way to reach a provider. Each provider is one class behind a single registry, and shared code never branches on the provider. Options are typed per provider: a Codex harness takes no `claude` block.
- The root entry is provider-neutral. `/codex`, `/claude`, `/cursor` and `/antigravity` export that provider's types only; `/native` and `/host-bridge` are removed, and provider hosts, transports and the Codex engine are internal.
- `/renderer` is now `/contracts`: data contracts, guards, capability tables, request conversions and session patches for code that runs without Node. Its list of exports is frozen and only shrinks; native conversation replicas and transcript helpers are not on it.
- `forkConversation(session, target, turnId?)` forks into the target session's folder. Without a turn, a running source forks from its last completed turn, and the result reports `forkedFromTurnId`. It resolves `null` when the provider cannot fork the conversation yet. `forkWorktreeConversation` is removed.
- Assistant text carries its work phase (`commentary` or `final_answer`) for every provider. `isBookkeepingTool` tells the harness which of the app's own tool calls are not work. The phase inference helpers and Claude's `inferWorkPhases` option are removed.
- The SDK adds no prompt text or policy of its own. Plan-exit denial, session-handoff wording and Antigravity's inspection and schema wording are removed; apps supply them through `claude.decideTool` and their own prompts. `outputSchema` is rejected where the provider cannot enforce it.
- `startReview` runs a provider's own review. Codex's `/review` prompt command now starts the native review instead of sending text.
- Every optional operation has a capability flag, kept in step with its implementation by a conformance test. New flags cover interrupted-turn continuation, conversation content and storage, turn history, and MCP support for required servers and automatic approval. Claude reports reasoning effort and service tiers.
- `Harness` covers login, remote control, realtime, conversation summaries and storage, interrupted-turn continuation, conversation reconciliation, session syncing and provider-level capabilities. Operations a provider lacks reject with `HarnessUnsupportedError`.
- `session.patch` events carry each change to a session as plain JSON ops with a revision, so a session's state can cross a wire incrementally. `readSessionSnapshot` returns the state at a revision to start from, `applySessionPatch` applies a patch, and a missed revision throws `SessionPatchGapError` and an invalid patch throws `SessionPatchInvalidError`, so the consumer reads a fresh snapshot. `session.changed` carries the same revision.
- `SessionState.planMode` reports whether the session plans before acting, for providers that track it.
- Tool confirmation requests carry the `itemId` of the transcript tool call they confirm, so an app can show the two as one.
- `harness.onEvent` hands consumers neutral events only. Conversation activity arrives as `turn.started`, `turn.completed` (status, error, retry), `session.error`, `tool.updated`, `turn.output`, `diff.updated` and `file.activity`, the same for every harness. Activity follows the session state it describes, so `readSession` on `turn.completed` shows the turn finished; `turn.output` marks a turn's first output. Plans every harness proposes arrive as `plan.readyForReview`. Provider updates such as models, skills, settings, goals, subagents and rate limits arrive typed as `HarnessNotice`. Native conversation frames never leave the SDK, and `provider.event` is removed.
- Persisted and wire names use `provider` instead of `backend`.
- `/testing` provides `createScriptedHarness`, `createScriptedCodexHarness` and `createScriptedClaudeHarness`: Harnesses whose provider is scripted by the test.
- `/runtime` finds provider executables and builds their search path.
- The root exports only provider-neutral message, request and approval contracts. Use `Message` and `MessagePart` for `ConversationMessage*`; `AgentRequest` and `AgentRequestResponse` for `ClientRequest` and `ClientRequestResponse`; `ProviderApprovalRequest`, `ProviderApprovalDecision`, `ProviderApprovalScope` and `ProviderRequestedPermission` for `Approval`, `ApprovalDecision`, `ApprovalScope` and `RequestedPermission`; `SendPromptOptions`, `ReferenceSendPromptOptions`, `PromptAttachment` and `PromptReferenceAttachment` for `SendMessageOptions`, `ClientSendMessageOptions`, `Attachment` and `ClientAttachment`; `ModelOption`, `SkillSummary`, `PluginSummary` and `ProviderServiceTier` for `ModelDescriptor`, `Skill`, `Plugin` and `ServiceTier`; and `ConversationSettings` for `UpdateConversationSettings`. `ConversationRenderStrategy` and `ConversationQueuedPrompt` are removed, and `codex.imageModel` receives `ModelOption`s.
- `/codex` exports `CodexConversationMessage` and `CodexClientRequest`, the message and request shapes in Codex snapshots and events.
- `npm run check:package` fails when the public types reach a provider engine, use display wording or export Codex's client contracts, so none of them can leak back in.

## 0.26.0 (2026-11-10)

- Public subpaths use extensionless imports such as `@korus-dev/multi-agent-sdk/codex`, resolved through an explicit exports map. Replace previous `.js` subpath imports; root forwarding files are removed.
- Native hosts use `CodexHost`, `ClaudeHost`, `CursorHost` and `AntigravityHost`. Shared message contracts use `ConversationMessage*`; portable contracts use canonical names without a provider prefix.
- The bridge entry is `/host-bridge`. Codex engine options use `codex.host`; adapter policy uses `codex.adapter`. SDK host events use `host.statusChanged` and `host_disconnected`.
- The generic `TtlCache` is available from the package root; text generation uses the shared `HarnessTextGenerationResult`.
- Updates the Codex SDK dependency to `0.167.1`.

## 0.25.1 (2026-11-10)

- Browser-safe renderer entry for conversation replicas, presentation, capabilities, requests and work phases.
- Native entry exposes provider hosts, transcript/authentication helpers, runtime discovery and session MCP bridging.

## 0.25.0 (2026-11-10)

- Unified Node.js harness API for Codex, Claude, Cursor, and Antigravity.
- Opaque sessions and conversation references with consumer-owned restoration data.
- Provider-owned messages, turns, approvals, history, settings, and usage observations.
- Scoped execution, runtime/catalog integration, MCP policy, and native Codex compatibility seams.
- Public guides, API reference, runnable Node example, and isolated package validation.
