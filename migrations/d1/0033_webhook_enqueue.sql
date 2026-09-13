CREATE TRIGGER audit_event_enqueue_webhooks
AFTER INSERT ON audit_event
BEGIN
  INSERT INTO webhook_outbox (
    organization_id, endpoint_id, audit_event_id, envelope_id, event_type,
    payload_json, status, attempts, available_at, updated_at
  )
  SELECT
    NEW.organization_id,
    endpoint.id,
    NEW.id,
    NEW.envelope_id,
    NEW.event_type,
    json_object(
      'eventType', NEW.event_type,
      'organizationId', NEW.organization_id,
      'envelopeId', NEW.envelope_id,
      'auditEventId', NEW.id,
      'sequence', NEW.sequence,
      'occurredAt', NEW.occurred_at
    ),
    'pending',
    0,
    NEW.occurred_at,
    NEW.occurred_at
  FROM webhook_endpoint endpoint
  WHERE endpoint.organization_id = NEW.organization_id
    AND endpoint.status = 'active'
    AND EXISTS (
      SELECT 1 FROM json_each(endpoint.events_json)
      WHERE json_each.value = NEW.event_type
    );
END;
