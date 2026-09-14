import { describe, expect, it } from 'vitest';
import { boundEnvelopeId } from './envelope-binding';

const envelopeA: string = '01910000-0000-7000-8000-000000000001';
const envelopeB: string = '01910000-0000-7000-8000-000000000011';

describe('boundEnvelopeId', () => {
	it('returns the UUIDv7 when every present source agrees', () => {
		expect(boundEnvelopeId(envelopeA)).toBe(envelopeA);
		expect(boundEnvelopeId(envelopeA, envelopeA, undefined)).toBe(envelopeA);
		expect(boundEnvelopeId(null, envelopeA, envelopeA)).toBe(envelopeA);
	});

	it('fails closed on mismatch, missing sources, or a non-UUIDv7 value', () => {
		expect(boundEnvelopeId()).toBeNull();
		expect(boundEnvelopeId(undefined, null)).toBeNull();
		expect(boundEnvelopeId(envelopeA, envelopeB)).toBeNull();
		expect(boundEnvelopeId(envelopeA, 'not-a-uuid')).toBeNull();
		expect(boundEnvelopeId('00000000-0000-4000-8000-000000000001')).toBeNull();
	});
});
