import { describe, expect, it } from 'vitest';
import {
	AUDIT_EVENT_CATALOG,
	WEBHOOK_AUDIT_EVENT_TYPES,
	isAllowedActorType,
	isAuditEventType
} from './catalog';

describe('audit event catalog', () => {
	it('exposes capability reissue and envelope expiry on the webhook surface', () => {
		expect(isAuditEventType('recipient.capability_reissued')).toBe(true);
		expect(isAuditEventType('envelope.expired')).toBe(true);
		expect(WEBHOOK_AUDIT_EVENT_TYPES).toContain('recipient.capability_reissued');
		expect(WEBHOOK_AUDIT_EVENT_TYPES).toContain('envelope.expired');
		expect(AUDIT_EVENT_CATALOG['recipient.capability_reissued']?.actorTypes).toEqual([
			'user',
			'agent'
		]);
		expect(AUDIT_EVENT_CATALOG['envelope.expired']?.actorTypes).toEqual(['system']);
		expect(isAllowedActorType('recipient.capability_reissued', 'user')).toBe(true);
		expect(isAllowedActorType('recipient.capability_reissued', 'agent')).toBe(true);
		expect(isAllowedActorType('recipient.capability_reissued', 'system')).toBe(false);
		expect(isAllowedActorType('envelope.expired', 'system')).toBe(true);
		expect(isAllowedActorType('envelope.expired', 'user')).toBe(false);
	});

	it('exposes PDF seal publication on the webhook surface with a system-only actor', () => {
		expect(isAuditEventType('envelope.pdf_seal_published')).toBe(true);
		expect(WEBHOOK_AUDIT_EVENT_TYPES).toContain('envelope.pdf_seal_published');
		expect(AUDIT_EVENT_CATALOG['envelope.pdf_seal_published']?.actorTypes).toEqual(['system']);
		expect(isAllowedActorType('envelope.pdf_seal_published', 'system')).toBe(true);
		expect(isAllowedActorType('envelope.pdf_seal_published', 'user')).toBe(false);
	});

	it('keeps webhook event types in catalog key order without duplicates', () => {
		expect(WEBHOOK_AUDIT_EVENT_TYPES).toEqual(Object.keys(AUDIT_EVENT_CATALOG));
		expect(new Set(WEBHOOK_AUDIT_EVENT_TYPES).size).toBe(WEBHOOK_AUDIT_EVENT_TYPES.length);
	});
});
