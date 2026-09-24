# Xero data and model-provider consent: implementation boundary

This is an engineering design note, not an owner agreement or a claim of compliance. The current application **does not record separate consent to send Xero API data to a third-party model or live-audio provider**. Accepting the general workspace terms does not grant that consent.

The proposed record is owner-scoped and versioned: the Xero tenant and connection generation, the specifically named model and live-audio providers, the stated purpose of sending Xero-derived data, the relevant privacy version, an explicit consent action, and a timestamp. A change of tenant, provider, purpose or privacy version requires a fresh choice. Revocation must block future disclosures; it cannot retract data already sent. Before enabling this path, confirm that each provider's handling of Xero API data fits the application's Xero agreement, including its restriction on AI training.

The following are distinct gates. A checkbox beside the Xero connection button would not cover them:

1. `apps/server/src/business/observer.ts`: changed Xero facts currently create an agent task containing source references and evidence. Check consent before creating the task, and preserve pending changes so they are not silently lost if consent is absent.
2. `apps/server/src/business/mcp-server.ts`: `business_sync`, `business_entities`, `business_observation`, `business_connections`, `business_capabilities` and `business_publish_view` can return Xero-derived fields to Hermes. Block or redact Xero content even when a tool query omits the provider filter or combines providers.
3. `apps/server/src/engine/model.ts` and `apps/server/src/conversations.ts`: task prompts, saved memory and previous chat messages can contain Xero results. Track provenance or conservatively withhold affected context before submission to Hermes's configured third-party model.
4. `apps/server/src/engagement/voice-provider.ts` and `apps/server/src/engagement/service.ts`: prior conversation context is sent to the live-audio provider, and delegated answers may contain Xero values. Obtain a separate explicit choice for this provider or keep Xero context and answers out of live voice.

The general owner acceptance gate records only the workspace terms and privacy versions. It does not unlock any of these model-disclosure paths. Test every gate both before consent and after revocation, including saved facts, mixed-provider queries, background tasks, prior conversations and an already connected Xero tenant. See [Xero's developer terms](https://developer.xero.com/xero-developer-platform-terms-conditions), especially clauses 7, 9 and 12, for the source requirements to review.
