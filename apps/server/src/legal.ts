import { createHash } from "node:crypto";

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | OpenMuse Business OS</title></head>
<body><main><h1>${title}</h1><p>OpenMuse Business OS · 24 September 2026</p>${body}<p><a href="/">Return to OpenMuse</a></p></main></body></html>`;

export const privacyHtml = page(
  "Privacy notice",
  `<p>This notice describes the owner-operated OpenMuse Business OS workspace. The deployment owner decides which accounts to connect. OpenMuse is designed as a single-owner, self-hosted application; anyone holding a valid owner key or session can access that workspace. This notice does not replace a connected provider's own privacy notice.</p>
<h2>Data used</h2><p>The workspace stores sign-in sessions; conversations, tasks, plans and saved memory; uploaded and generated documents; voice transcripts and call records; device push tokens and notification records; and account connection status. With the owner's authorization, it can read Square merchant, location and payment records; Xero organisation, account, bank transaction, invoice, bill and contact records; Revolut Business account and transaction records; and Google mail and calendar data. Business connector facts are cached locally. The exact available fields and time periods depend on each connection and its granted scopes.</p>
<h2>Why and where</h2><p>The data supports the workspace, account views, searches, background change detection, agent work, notifications and recovery. The API, database, files and isolated Hermes agent run on the owner's Oracle host. OAuth tokens saved in the database are encrypted with a server-held key; other workspace records and backups require protection by the host and backup operator. Access uses an owner key or a session issued from it.</p>
<h2>External services</h2><p>Connecting an account sends authorization and read requests to that provider. Relevant workspace context may be sent by Hermes to its configured model provider when the agent works on a request. When live voice is used, audio travels directly to the configured live-audio provider; the app requests that provider's session storage be disabled, while voice transcripts are saved in the local workspace. Apple Push Notification service receives device tokens and notification payloads; lock-screen alert text is generic. Other tools the owner authorizes may contact external sites and services.</p>
<h2>Retention and control</h2><p>Disconnecting a stored provider credential stops that connection and prevents its old facts from being presented as newly verified; it does not automatically delete historical records, conversations, files, transcripts or backups. A Square token supplied through Oracle's environment must be removed there separately. The current application has no fixed automatic deletion period or single global erase control. The deployment owner controls account consent, stored records, host access and backup retention, and should handle access or deletion requests through the business's usual contact channel.</p>`,
);

export const termsHtml = page(
  "Terms of use",
  `<p>These terms describe use of this owner-operated OpenMuse Business OS workspace. Access is intended only for the business owner and people the owner authorizes. The business operating the deployment is responsible for its accounts, data, configuration and use of the application. The source-code MIT license is separate from these workspace terms.</p>
<h2>Connections and actions</h2><p>Each connected service remains subject to its own terms and permissions. The owner chooses which accounts to connect. Stored credentials can be disconnected through authenticated server tools; an environment-supplied Square token must be removed on Oracle. The agent can read authorized data, create local records and, when configured and authorized, propose or perform external actions within available provider permissions. Review consequential financial, legal, employment and customer-facing decisions against the original records. A displayed cached fact is not a guarantee of current provider state.</p>
<h2>Access and operation</h2><p>Keep the owner access key, provider credentials, devices and backup material secure. Do not use the workspace to access accounts or data without authority. The owner operates the host, backups, connected services and model configuration. Availability depends on those systems and the external providers; service interruptions and inaccurate model output can occur.</p>
<h2>Changes and questions</h2><p>The deployment owner may update the application and these terms. For questions about this deployment or its data, use the business's usual contact channel. Viewing this page or connecting an account does not count as agreement. Before opening a live workspace, the owner must explicitly accept the current terms and privacy notice; the workspace records when and which versions were accepted.</p>`,
);

// A text change creates a new version and requires an explicit new acceptance.
const version = (html: string) => createHash("sha256").update(html).digest("hex");
export const legalVersions = {
  terms: version(termsHtml),
  privacy: version(privacyHtml),
};

export interface LegalAcceptance {
  id: string;
  owner: string;
  acceptedAt: string;
  termsVersion: string;
  privacyVersion: string;
  method: "authenticated_acceptance_request";
}

export const legalAcceptanceId = `${legalVersions.terms}:${legalVersions.privacy}`;
