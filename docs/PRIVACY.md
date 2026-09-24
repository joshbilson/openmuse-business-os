# Privacy notice

OpenMuse Business OS · 24 September 2026

This notice describes the owner-operated OpenMuse Business OS workspace. The deployment owner decides which accounts to connect. OpenMuse is designed as a single-owner, self-hosted application; anyone holding a valid owner key or session can access that workspace. This notice does not replace a connected provider's own privacy notice.

## Data used

The workspace stores sign-in sessions; conversations, tasks, plans and saved memory; uploaded and generated documents; voice transcripts and call records; device push tokens and notification records; and account connection status. With the owner's authorization, it can read Square merchant, location and payment records; Xero organisation, account, bank transaction, invoice, bill and contact records; Revolut Business account and transaction records; and Google mail and calendar data. Business connector facts are cached locally. The exact available fields and time periods depend on each connection and its granted scopes.

## Why and where

The data supports the workspace, account views, searches, background change detection, agent work, notifications and recovery. The API, database, files and isolated Hermes agent run on the owner's Oracle host. OAuth tokens saved in the database are encrypted with a server-held key; other workspace records and backups require protection by the host and backup operator. Access uses an owner key or a session issued from it.

## External services

Connecting an account sends authorization and read requests to that provider. Relevant workspace context may be sent by Hermes to its configured model provider when the agent works on a request. When live voice is used, audio travels directly to the configured live-audio provider; the app requests that provider's session storage be disabled, while voice transcripts are saved in the local workspace. Apple Push Notification service receives device tokens and notification payloads; lock-screen alert text is generic. Other tools the owner authorizes may contact external sites and services.

## Retention and control

Disconnecting a stored provider credential stops that connection and prevents its old facts from being presented as newly verified; it does not automatically delete historical records, conversations, files, transcripts or backups. A Square token supplied through Oracle's environment must be removed there separately. The current application has no fixed automatic deletion period or single global erase control. The deployment owner controls account consent, stored records, host access and backup retention, and should handle access or deletion requests through the business's usual contact channel.
