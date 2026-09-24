# Local conversation persistence

This fork preserves OpenMuse's CopilotKit chat components and replaces required hosted Intelligence storage with owner-scoped `chat-threads`, `chat-messages`, `chat-runs` and `chat-events` records in the existing PostgreSQL store. Sample development can use PGlite. Production uses native PostgreSQL on Oracle.

The main conversation ID is stable. Side conversations support rename, archive and restore using local authenticated endpoints. Rich messages keep local task/document identifiers; authenticated APIs resolve current task state and short-lived file links.

Each user message has a durable run reservation. Hermes receives the same idempotency key on retries. Reloading reconciles the saved run rather than creating another operation. Stopping requests cancellation from Hermes and preserves already confirmed work. Voice transcript fragments remain in their exact local source log; completed voice messages are added to the same conversation history.

No hosted Intelligence key is required. The legacy upstream demo still has separate demo-only integration code and is not the business deployment entry point.

The tests cover local replay, owner isolation, restart/retry behavior, thread metadata, unavailable Hermes and stop semantics. Real multi-device use and physical iPhone audio acceptance are separate checks listed in BUSINESS-OS.md.
