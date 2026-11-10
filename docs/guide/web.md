# Web integration

The `/web` entry projects a **Codex native surface** over an established WebSocket. It does not expose the neutral multi-provider driver as a network service, create an HTTP server, or own website accounts and storage.

The host authenticates the HTTP upgrade, validates its origin, and acquires a surface for that user. After accepting the connection, bind it with `bindCodexWebSocket` from `/web/server` and adapt a Node socket with `createCodexNodeWebSocketPort`. The required `authorize(context)` callback returns `null` to deny access or a connection-scoped lease containing:

- `surface`: the authorized Codex surface target;
- optional `resolveAttachment`: a trusted resolver for opaque attachment references;
- optional `release`: cleanup for the host's acquired resources.

Use `isAllowedCodexWebSocketOrigin(request, allowedOrigins)` before accepting the upgrade. Missing origins are rejected. Browser WebSockets are not protected by ordinary same-origin fetch rules.

In the renderer, create `createCodexWebSurfaceClient({ createSocket })` from `/web/client`. Adapt a browser socket with `createCodexBrowserWebSocketPort`; it uses a structural socket interface without requiring DOM globals in the Node package.

The transport validates envelopes/arguments, correlates responses, serializes operations, and streams snapshots/events/state patches. Client and server default to a 64 MiB message ceiling; configure `maxMessageBytes` consistently and account for lower proxy limits. Reconnect behavior and request deadlines are client options. The transport does not make large histories small.

Hosts own upgrade paths, cookies/tokens, CSRF/origin checks, quotas, tenancy, process leases, attachment uploads, and durable storage. A socket lease grants access to a surface; it is not an isolation or authentication system. See [host security](security.md).
