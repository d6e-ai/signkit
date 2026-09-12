import { z, type ZodType } from 'zod';
import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';

/**
 * Request schema for a SignKit-owned identifier: envelopes, recipients,
 * fields, and audit events are all canonical lowercase UUIDv7, matching the
 * database check constraints on those columns.
 *
 * This is deliberately narrower than a general UUID check. It must never be
 * used for an external d6e-auth organization or user identifier, for a
 * caller-chosen idempotency key, or for opaque capability material.
 */
export const signkitIdentifierSchema: ZodType<string> = z.string().regex(UUID_V7_PATTERN);
