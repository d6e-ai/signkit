CREATE OR REPLACE FUNCTION audit_event_enqueue_webhooks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO webhook_outbox (
    endpoint_id, audit_event_id, envelope_id, event_type,
    payload_json, status, attempts, available_at, updated_at
  )
  SELECT
    endpoint.id,
    NEW.id,
    NEW.envelope_id,
    NEW.event_type,
    jsonb_build_object(
      'eventType', NEW.event_type,
      'envelopeId', NEW.envelope_id,
      'auditEventId', NEW.id,
      'sequence', NEW.sequence,
      'occurredAt', to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )::text,
    'pending',
    0,
    NEW.occurred_at,
    NEW.occurred_at
  FROM webhook_endpoint endpoint
  WHERE endpoint.status = 'active'
    AND endpoint.events_json::jsonb @> to_jsonb(NEW.event_type);
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_event_enqueue_webhooks
AFTER INSERT ON audit_event
FOR EACH ROW
EXECUTE FUNCTION audit_event_enqueue_webhooks();
