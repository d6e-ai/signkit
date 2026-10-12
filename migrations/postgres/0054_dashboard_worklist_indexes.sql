-- Supports the dashboard worklist (GET /api/v1/dashboard): the "all" view and
-- the sent/in_progress action-required and waiting views all scan across
-- multiple envelope statuses ordered by recency, which the existing
-- status-leading `envelope_status_updated` index cannot serve.
CREATE INDEX envelope_updated_id ON envelope(updated_at DESC, id DESC);

-- Supports the per-envelope recipient aggregates (counts, actionable-turn
-- lookup) the worklist computes in one query per request: these always
-- filter by envelope_id and then narrow by role/status, which the existing
-- `recipient_envelope_route` index (routing-order leading) cannot serve.
CREATE INDEX recipient_envelope_role_status ON recipient(envelope_id, role, status);
