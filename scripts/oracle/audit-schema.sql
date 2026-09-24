-- Run as openmuse_admin after transferring database ownership away from the
-- openmuse runtime role. Never apply this with the runtime application's login.
BEGIN;
DO $$
BEGIN
  IF current_user <> 'openmuse_admin' THEN
    RAISE EXCEPTION 'Audit migration requires openmuse_admin';
  END IF;
  IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) = 'openmuse' THEN
    RAISE EXCEPTION 'Transfer database ownership away from runtime role first';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS openmuse_audit AUTHORIZATION openmuse_admin;
DO $$
BEGIN
  IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'openmuse_audit') <> 'openmuse_admin' THEN
    RAISE EXCEPTION 'Audit schema is not admin-owned';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS openmuse_audit.head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  event_hash text NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$')
);
INSERT INTO openmuse_audit.head(singleton, sequence, event_hash)
VALUES (true, 0, repeat('0', 64)) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS openmuse_audit.events (
  sequence bigint PRIMARY KEY,
  occurred_at text NOT NULL,
  principal_kind text NOT NULL,
  principal_id text NOT NULL,
  action text NOT NULL,
  source text NOT NULL,
  outcome text NOT NULL,
  request_id text,
  previous_hash text NOT NULL,
  payload_text text NOT NULL,
  event_hash text NOT NULL UNIQUE
);

-- The row lock on head serializes concurrent appends. A failed transaction
-- rolls back both its event and head update, leaving no false sequence gap.
CREATE OR REPLACE FUNCTION openmuse_audit.append_event(
  p_principal_kind text,
  p_principal_id text,
  p_action text,
  p_source text,
  p_outcome text,
  p_request_id text DEFAULT NULL
)
RETURNS TABLE (
  sequence bigint, occurred_at text, principal_kind text, principal_id text,
  action text, source text, outcome text, request_id text,
  previous_hash text, payload_text text, event_hash text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, openmuse_audit AS $$
DECLARE
  v_sequence bigint;
  v_previous text;
  v_occurred text;
  v_payload text;
  v_hash text;
BEGIN
  IF p_principal_kind NOT IN ('owner', 'process') OR
     p_principal_id !~ '^[a-zA-Z0-9._:-]{1,128}$' OR
     p_action !~ '^[a-z][a-z0-9._-]{0,95}$' OR
     p_source !~ '^[a-z][a-z0-9._-]{0,95}$' OR
     p_outcome NOT IN ('success', 'failure', 'denied', 'unknown') OR
     (p_request_id IS NOT NULL AND p_request_id !~ '^[a-f0-9-]{16,64}$') THEN
    RAISE EXCEPTION 'Invalid redacted audit event';
  END IF;

  SELECT h.sequence + 1, h.event_hash INTO v_sequence, v_previous
    FROM openmuse_audit.head AS h WHERE h.singleton = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Audit chain head is missing'; END IF;
  v_occurred := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  v_payload := jsonb_build_array(
    'v1', v_sequence::text, v_occurred, p_principal_kind, p_principal_id,
    p_action, p_source, p_outcome, p_request_id
  )::text;
  v_hash := encode(sha256(convert_to(v_previous || E'\n' || v_payload, 'UTF8')), 'hex');
  INSERT INTO openmuse_audit.events VALUES (
    v_sequence, v_occurred, p_principal_kind, p_principal_id, p_action,
    p_source, p_outcome, p_request_id, v_previous, v_payload, v_hash
  );
  UPDATE openmuse_audit.head AS h SET sequence = v_sequence, event_hash = v_hash
    WHERE h.singleton = true;
  RETURN QUERY SELECT e.sequence, e.occurred_at, e.principal_kind, e.principal_id,
    e.action, e.source, e.outcome, e.request_id, e.previous_hash,
    e.payload_text, e.event_hash FROM openmuse_audit.events AS e
    WHERE e.sequence = v_sequence;
END $$;

REVOKE ALL ON SCHEMA openmuse_audit FROM PUBLIC, openmuse;
REVOKE ALL ON ALL TABLES IN SCHEMA openmuse_audit FROM PUBLIC, openmuse;
REVOKE ALL ON FUNCTION openmuse_audit.append_event(text,text,text,text,text,text) FROM PUBLIC, openmuse;
GRANT USAGE ON SCHEMA openmuse_audit TO openmuse;
GRANT EXECUTE ON FUNCTION openmuse_audit.append_event(text,text,text,text,text,text) TO openmuse;
COMMIT;
