# Troubleshooting

| Symptom | Check |
| --- | --- |
| Runtime unavailable | Inspect `getRuntimeStatus()`, executable discovery, CLI version, and the environment inherited by the host process. |
| Not authenticated | Check `authenticate({ action: 'check' })` in the intended provider home; use that provider's native login flow. |
| Send returned but work continues | `sendPrompt` reports admission. Track the admitted turn through `session.changed`. |
| Old conversation settings changed | Ensure the host did not supply an explicit default or policy callback. Omitted permission preferences preserve native settings. |
| A control rejects | Read `getCapabilities(session)` and native catalog metadata. Unsupported behavior is not emulated. |
| Handle rejected | Sessions and refs belong to the harness that issued them. Move detached restoration data, then restore in the new harness. |
| Messages stop updating | Handle `recovery.required`, report its reason, and reload authoritative state. |
| Preview missing after restart | Provider history may retain a path without live content access. Use host-owned durable attachments. |
| New checkout cannot install | The pinned Codex SDK version must exist on the configured registry. Local source mode does not replace npm dependency installation. |
| Tests time out on a busy machine | The default suite uses two workers. Isolate the owning fixture before raising deadlines. |

For bug reports include package versions, OS/Node version, provider runtime/version, operation, and a sanitized reproduction. Remove credentials, private paths, conversation text, and MCP secrets.
