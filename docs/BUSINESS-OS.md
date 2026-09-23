# OpenMuse Business OS

The application is a source fork of OpenMuse, pinned in `upstream.lock.json`. It preserves the original Expo client, navigation, chat components, palette, task screens and artifact renderers. Business connections appear within its Apps screen; calling extends its chat controls. Web is the Mac client. Native iOS uses a local Xcode build; Android shares the Expo source.

## Runtime

The Hono API, web export, PostgreSQL, files, connection vault and durable task worker run on Oracle. A dedicated Hermes profile handles both interactive conversations and background tasks. Provider and model selection live in that profile and matching server environment variables. The installed Hermes API reports the executed model, but does not echo the provider: the bridge validates the reported model and any available runtime fields. The isolated profile selects a provider explicitly and has no fallback configured.

Local conversations replace required hosted Intelligence persistence. Owner-bound rows preserve threads, ordered messages, events and run reservations. Voice transcripts enter that history. Incoming messages are context, never authority to change standing instructions. Stored business memory enters later Hermes conversations.

Hermes connects to two self-hosted stdio MCP servers: business read/sync tools and operator tools for tasks, memory, notifications, calls, Gmail/calendar reads and the existing action ledger. Repeated task/action requests reuse stable idempotency keys. Ambiguous external write outcomes remain uncertain and are not retried automatically. The selected standing-authorization mode avoids repeated approval for work already authorized by the owner; account OAuth scopes still constrain possible actions.

The profile opts out of bundled skills before starting. Only independently written business skills from this fork are copied into its skill directory. No Anthropic or OpenAI skill collection is installed.

## Connections and proactivity

Direct Square, Xero, Revolut Business and Google adapters store provider identity, connection generation, source timestamps, original currency/units and request evidence. Status distinguishes configured credentials, verified identity and successful synchronization. OAuth credentials are encrypted with the server vault key. Codex plugin sessions are not silently exported into this application.

Verified sources are polled every five minutes with durable baseline and pagination state. Initial history is quiet; subsequent meaningful changes create deduplicated Hermes work. The owner can also create tasks, goals and recurring watches through OpenMuse. Task outcomes and notifications persist without the phone being open.

Hermes can publish cards and tables inside the existing Apps screen through `business_publish_view`. It chooses a title, layout and saved fact IDs; the server resolves financial values, verified account identity and evidence from those facts. Saved views are immutable snapshots with source dates. Repeated requests return the same view, and disconnected/replaced account facts cannot be presented as newly verified data. This provides generated business views using the fork's own components.

See [connector capabilities and coverage limits](BUSINESS-CONNECTORS.md) and [direct account setup](CONNECTION-SETUP.md). Staffing, bookings, suppliers and website-specific adapters remain extension work; general authorized Hermes tools can support other work, but an unimplemented connector is never shown as connected.

## Voice and notifications

GPT-Live-1 is the initial full-duplex provider. The browser/phone sends WebRTC audio directly to the provider. Oracle holds the key, creates the session, attaches a control connection and delegates business requests to durable Hermes tasks. Provider replacement must meet the same simultaneous speaking/listening acceptance; a transcription/text/speech pipeline is not an accepted substitute.

The iOS Expo module registers PushKit before JavaScript, reports real incoming calls through CallKit, buffers cold-start events and activates WebRTC audio after CallKit activation. Calling supports local hang-up while the provider is still connecting, mute and speaker controls. The client monitors media and Oracle control health: brief loss shows Reconnecting, an unrecovered loss ends the session, and Call again starts a fresh session in the same conversation. Audio routing and interruptions require real-device verification.

Ordinary alerts and real call invitations use direct APNs HTTP/2 requests from Oracle. The durable outbox deduplicates events, expires stale rings, retries transient failures and retires invalid tokens. Lock-screen text is generic. Call reason and business details remain behind authentication. Transcripts persist locally; raw audio recording defaults off and provider session storage is disabled.

## Deployment and recovery

The reference Windows deployment is isolated under `C:\OpenMuseBusinessOS`. Native PostgreSQL 17.11 runs as `OpenMusePostgres` on loopback port 5433. API and Hermes scheduled tasks start at boot, on loopback ports 8791 and 8766. Tailscale Serve publishes the API and UI using an already permitted tailnet port. Existing Oracle services remain separate. The host and the device must both be on the tailnet for access.

Use the pinned source and dependencies in `upstream.lock.json`. The Hermes base install needs the pinned optional API/MCP dependencies as well. `scripts/oracle/configure.py` prepares an isolated profile and creates new app credentials without printing secrets. `run.ps1` and `stop.ps1` manage the dedicated process trees. Provider keys, bank private keys, owner access key and encryption key stay outside Git. The application deliberately does not ship deployment credentials.

`pnpm build:server` builds the API. `EXPO_PUBLIC_API_URL=<private HTTPS URL> pnpm build:web` builds its actual client; the API serves that export. Native builds use the same variable. [Native iOS instructions](../apps/mobile/docs/IOS-CALLING.md) cover development versus production APNs entitlements.

[Backup and restore scripts](BACKUP-RESTORE.md) use `pg_dump`, file hashes and private recovery material. Quiesce API/Hermes writers before a backup and include the isolated Hermes home. Verification restores only to a new database and checks record and file hashes. A backup on the same machine is not protection from loss of that machine; an off-machine copy remains an operational setup decision.

## Acceptance boundary

Automated checks cover ownership, conversation replay, task restart, repeat-action suppression, source evidence, OAuth state/refresh races, notification retry and call invitation lifecycle. Native and JavaScript builds validate compilation, not physical-device behavior.

The packaged iOS Simulator app has built and launched using the original OpenMuse welcome interface. A physical iPhone was detected, but signing was blocked by Xcode's missing account and missing development provisioning profile for the new bundle. Real APNs delivery, foreground/background/locked/cold-start/force-quit calls, human overlapping speech, interruption, reconnection and Bluetooth/speaker routing remain mandatory physical acceptance checks. Consult the private deployment acceptance report for the current executed checks rather than interpreting these implementation notes as a claim that every device test passed.

## Upstream maintenance

Keep `upstream` pointed at CopilotKit/OpenMuse and update the application commit deliberately. Most business code is in added `business`, `operator`, `engagement` and local conversation modules; the native addition is a local Expo module/config plugin. Preserve upstream MIT attribution. Review future chat/runtime transport changes before updating the pinned CopilotKit packages, then rerun the local AG-UI replay and native calling checks.
