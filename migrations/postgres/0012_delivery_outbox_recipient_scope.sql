-- A delivery intent must target a recipient belonging to the exact envelope,
-- not merely another recipient in the same organization.
ALTER TABLE delivery_outbox
  ADD CONSTRAINT delivery_outbox_recipient_scope
  FOREIGN KEY (organization_id, envelope_id, recipient_id)
  REFERENCES recipient(organization_id, envelope_id, id);
