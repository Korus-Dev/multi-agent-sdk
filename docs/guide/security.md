# Host security

Run the Node harness in trusted server or main-process code. The host authorizes working folders, provider homes, executables, MCP endpoints, permission changes, and tool scope. UI capabilities are presentation metadata, not authorization.

Keep native credentials, home paths, raw runtime configuration, and restoration data in application-private storage. Do not expose provider host options or arbitrary filesystem reads to a renderer. Supply paths/resolvers explicitly; the SDK does not discover product configuration from ambient `APP_*` variables.

Attachment readers are session-scoped. Authorize uploads and resolve opaque references in trusted host code. Applications own durable attachment retention: a path left in provider history does not guarantee that a preview remains readable after restart.

Claude's configuration-home helpers are process-wide. Use sequential close/recreate when switching profiles. The single-home driver interface is not a concurrent tenant-isolation mechanism.

When reporting a vulnerability, avoid posting credentials or private conversation data in a public issue. Use the repository's private security reporting channel if enabled, or contact the maintainer privately.
