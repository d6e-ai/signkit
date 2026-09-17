# 2026-09-17 — Display-only instance member identity snapshots

## Context

SignKit authorizes operators by the d6e-auth subject stored in `instance_member`, but an external subject identifier is not useful in the member-management interface. d6e-auth proves the currently signed-in person's email and display name; it does not expose an administrator-facing directory lookup that SignKit can safely use to resolve arbitrary subjects.

## Decision

`instance_member` keeps nullable `display_name` and `email` snapshots copied from that member's own verified d6e-auth principal. Bootstrap and invitation acceptance persist the snapshot with the membership transaction. Later authenticated requests refresh the current member's snapshot best-effort when it has changed.

These fields are labels only. Membership, roles, suspension, command ownership, and every authorization decision continue to use the immutable d6e-auth subject plus SignKit-local role and status. Snapshot refresh failure cannot make a valid membership fail authentication, and another caller cannot supply identity data for a member.

## Consequences

- Member lists show a recognizable name and email without issuing one remote lookup per row.
- Existing rows remain valid after the additive migration; their labels appear after those members next authenticate.
- Labels may be stale until the member signs in again and must not be used as authority or stable identifiers.
- A future d6e-auth directory API is not required for this UI and must not be introduced merely to render member labels.
