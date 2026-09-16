-- A delivery intent must target a recipient belonging to the exact envelope,
-- not merely another recipient in the same instance.
ALTER TABLE delivery_outbox
  ADD CONSTRAINT delivery_outbox_recipient_scope
  FOREIGN KEY (recipient_id) REFERENCES recipient(id);
