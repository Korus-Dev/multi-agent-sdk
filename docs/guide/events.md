# State and events

`readSession(session)` returns the current neutral projection. Subscribe with `onEvent` to update the host view. The unsubscribe function removes that listener; `close()` owns native driver cleanup.

| Event | Use |
| --- | --- |
| `session.changed` | Render messages, turns, busy state, pending requests, title, plan, goal, settings, and history state. |
| `request.created` / `request.resolved` | Present or retire provider approval/question controls. |
| `status.changed` | Show provider-reported work/status detail. |
| `plan.readyForReview` | Present a provider-authored plan for host review. |
| `recovery.required` | Surface the reason and reload authoritative conversation state before continuing incremental rendering. |
| `usage.observed` | Record execution-level accounting evidence. |
| `requestUsage.observed` | Record request-level accounting evidence where supplied. |

Messages use the shared `Message`/`MessagePart` contracts. Provider replicas own their state and ordering; the neutral interface does not replace native behavior with a universal reducer. Turn details include native failure/retry evidence, timing, and execution usage.

A successful admission is independent of a successful turn. Correlate terminal status with `Admission.turnId` when supplied; do not infer completion merely because a message arrived or `sendPrompt` resolved.

Pending-request snapshots are authoritative for Codex and ACP. Claude retains requests unless native answers or resolution events establish that they were handled. Unknown pending, usage, model, token, request, and cost information stays unknown. Do not coerce missing accounting evidence to zero.

Use `driver.getCapabilities(session)` to decide which actions to offer. Capability flags control presentation; trusted host code still owns authorization. Operations that a provider does not implement reject rather than emulating unsupported native behavior.
