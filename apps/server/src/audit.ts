import { createHash } from "node:crypto";

/** No URL, request body, provider payload, credential, or free-form message is accepted. */
export type AuditInput = {
  principalKind: "owner" | "process";
  principalId: string;
  action: string;
  source: string;
  outcome: "success" | "failure" | "denied" | "unknown";
  requestId?: string;
};

export type AuditEvent = AuditInput & {
  sequence: bigint;
  occurredAt: string;
  previousHash: string;
  payloadText: string;
  eventHash: string;
};

type Queryable = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

const namePattern = /^[a-z][a-z0-9._-]*$/;
const principalPattern = /^[a-zA-Z0-9._:-]+$/;
const requestPattern = /^[a-fA-F0-9-]{16,64}$/;
const hashPattern = /^[a-f0-9]{64}$/;

export function redactedAuditInput(value: AuditInput): AuditInput {
  if (
    !["owner", "process"].includes(value.principalKind) ||
    !principalPattern.test(value.principalId) ||
    value.principalId.length > 128 ||
    !namePattern.test(value.action) ||
    value.action.length > 96 ||
    !namePattern.test(value.source) ||
    value.source.length > 96 ||
    !["success", "failure", "denied", "unknown"].includes(value.outcome) ||
    (value.requestId !== undefined && !requestPattern.test(value.requestId))
  ) {
    throw new TypeError("Invalid redacted audit event");
  }
  // Explicit projection also strips unexpected runtime properties from untrusted callers.
  return {
    principalKind: value.principalKind,
    principalId: value.principalId,
    action: value.action,
    source: value.source,
    outcome: value.outcome,
    ...(value.requestId === undefined ? {} : { requestId: value.requestId.toLowerCase() }),
  };
}

function eventFromRow(row: Record<string, unknown>): AuditEvent {
  return {
    sequence: BigInt(String(row.sequence)),
    occurredAt: String(row.occurred_at),
    principalKind: row.principal_kind as AuditInput["principalKind"],
    principalId: String(row.principal_id),
    action: String(row.action),
    source: String(row.source),
    outcome: row.outcome as AuditInput["outcome"],
    ...(row.request_id === null ? {} : { requestId: String(row.request_id) }),
    previousHash: String(row.previous_hash),
    payloadText: String(row.payload_text),
    eventHash: String(row.event_hash),
  };
}

/** Calls the restricted SECURITY DEFINER function; no direct audit-table writes. */
export class AuditWriter {
  constructor(private readonly database: Queryable) {}

  async append(raw: AuditInput): Promise<AuditEvent> {
    const event = redactedAuditInput(raw);
    const result = await this.database.query(
      `SELECT sequence, occurred_at, principal_kind, principal_id, action, source,
              outcome, request_id, previous_hash, payload_text, event_hash
         FROM openmuse_audit.append_event($1,$2,$3,$4,$5,$6)`,
      [
        event.principalKind,
        event.principalId,
        event.action,
        event.source,
        event.outcome,
        event.requestId ?? null,
      ],
    );
    if (result.rows.length !== 1) throw new Error("Audit append returned no event");
    return eventFromRow(result.rows[0]);
  }
}

/** Verify one contiguous segment against an independently retained previous hash. */
export function verifyAuditChain(
  events: readonly AuditEvent[],
  startSequence: bigint,
  startHash: string,
) {
  if (!hashPattern.test(startHash)) return false;
  let previous = startHash;
  let sequence = startSequence;
  for (const event of events) {
    if (event.sequence !== sequence || event.previousHash !== previous) return false;
    if (!hashPattern.test(event.eventHash)) return false;
    let fields: unknown;
    try {
      fields = JSON.parse(event.payloadText);
    } catch {
      return false;
    }
    if (
      !Array.isArray(fields) ||
      fields.length !== 9 ||
      fields[0] !== "v1" ||
      fields[1] !== event.sequence.toString() ||
      fields[2] !== event.occurredAt ||
      fields[3] !== event.principalKind ||
      fields[4] !== event.principalId ||
      fields[5] !== event.action ||
      fields[6] !== event.source ||
      fields[7] !== event.outcome ||
      fields[8] !== (event.requestId ?? null)
    )
      return false;
    if (
      createHash("sha256").update(`${previous}\n${event.payloadText}`).digest("hex") !==
      event.eventHash
    )
      return false;
    previous = event.eventHash;
    sequence += 1n;
  }
  return true;
}
