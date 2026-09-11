CREATE TABLE recipient_approved_command (
  organization_id text NOT NULL,
  envelope_id text NOT NULL,
  recipient_id text NOT NULL,
  recipient_role text NOT NULL CHECK (recipient_role = 'approver'),
  routing_order integer NOT NULL CHECK (routing_order BETWEEN 1 AND 1000),
  actor_type text NOT NULL CHECK (actor_type = 'recipient'),
  actor_id text NOT NULL CHECK (actor_id = recipient_id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  capability_hash text NOT NULL,
  sent_commit_sha text NOT NULL,
  updated_at timestamptz NOT NULL,
  next_routing_order integer CHECK (
    next_routing_order IS NULL OR (next_routing_order BETWEEN 1 AND 1000 AND next_routing_order > routing_order)
  ),
  next_capability_expires_at timestamptz,
  released_delivery_count integer NOT NULL CHECK (released_delivery_count BETWEEN 0 AND 50),
  audit_event_id text NOT NULL,
  audit_sequence bigint NOT NULL CHECK (audit_sequence > 1),
  previous_audit_hash text NOT NULL,
  audit_event_hash text NOT NULL,
  audit_payload_json text NOT NULL,
  completed_audit_event_id text,
  completed_audit_event_hash text,
  completed_audit_payload_json text,
  PRIMARY KEY (organization_id, actor_type, actor_id, idempotency_key),
  UNIQUE (organization_id, recipient_id),
  UNIQUE (organization_id, audit_event_id),
  UNIQUE (organization_id, completed_audit_event_id),
  FOREIGN KEY (organization_id, envelope_id) REFERENCES envelope(organization_id, id),
  FOREIGN KEY (organization_id, recipient_id) REFERENCES recipient(organization_id, id),
  CHECK (
    (
      completed_audit_event_id IS NULL
      AND completed_audit_event_hash IS NULL
      AND completed_audit_payload_json IS NULL
    ) OR (
      completed_audit_event_id IS NOT NULL
      AND completed_audit_event_hash IS NOT NULL
      AND completed_audit_payload_json IS NOT NULL
      AND completed_audit_event_id <> audit_event_id
      AND next_routing_order IS NULL
      AND next_capability_expires_at IS NULL
      AND released_delivery_count = 0
    )
  ),
  CHECK (
    (
      next_routing_order IS NULL
      AND next_capability_expires_at IS NULL
      AND released_delivery_count = 0
    ) OR (
      next_routing_order IS NOT NULL
      AND next_capability_expires_at IS NOT NULL
      AND released_delivery_count > 0
      AND completed_audit_event_id IS NULL
    )
  )
);

CREATE INDEX recipient_approved_command_envelope
  ON recipient_approved_command(organization_id, envelope_id, updated_at DESC);
