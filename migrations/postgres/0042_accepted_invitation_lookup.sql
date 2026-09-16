-- The invitation-accept path checks whether the local user has already
-- consumed an invitation. Accepted history is retained, so index exactly the
-- predicate used by that concurrency guard and enforce its one-user invariant.
CREATE UNIQUE INDEX instance_invitation_accepted_by_user
  ON instance_invitation(accepted_by_user_id)
  WHERE status = 'accepted';
