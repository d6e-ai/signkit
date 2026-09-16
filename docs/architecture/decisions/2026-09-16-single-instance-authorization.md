# ADR: one deployment is one SignKit instance

Date: 2026-09-16

## Status

Accepted. This is a destructive pre-release change.

## Decision

One deployment and its database are the only tenant boundary. SignKit no longer imports d6e organization membership, stores organization rows, accepts organization selectors, or grants API keys to organizations.

d6e-auth supplies identity claims only. SignKit authorizes operators through active local `instance_member` rows. Envelopes reference their creating member through a required `created_by_user_id`. API keys reference their owning member through a required `owner_user_id` and stop working when that owner is no longer active.

Audit hash v3, object keys, sealing associated data, webhooks, envelope commands, and recipient evidence contain no organization identifier. Recipient capabilities remain envelope-scoped.

## Consequences

- Existing D1 and PostgreSQL databases are incompatible and must be deleted or recreated before deploying this revision.
- Existing GitHub release artifacts that contain the old schema must not be used with the new database.
- Existing API clients must remove `SignKit-Organization-Id`, `--org`, and related configuration.
- There is no compatibility migration or legacy hash verifier.
- Backup and restore operate on the complete instance.

This reset is acceptable because SignKit has not yet shipped a supported data migration contract and the only known deployment is controlled by the project owner.
