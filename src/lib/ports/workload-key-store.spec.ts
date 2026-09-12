import { describe, expect, it } from 'vitest';
import {
	boundWorkloadKeyListLimit,
	isWorkloadKeyId,
	isWorkloadKeyIdempotencyKey,
	parseWorkloadKeyScopesJson,
	workloadKeyScopesJson,
	MAX_WORKLOAD_KEY_LIST_LIMIT
} from './workload-key-store';
import type { WorkloadKeyScope } from '$lib/security/workload-key';

describe('workload-key-store port helpers', () => {
	it('bounds the list limit to 1..100', () => {
		expect(MAX_WORKLOAD_KEY_LIST_LIMIT).toBe(100);
		expect(boundWorkloadKeyListLimit(0)).toBe(1);
		expect(boundWorkloadKeyListLimit(-10)).toBe(1);
		expect(boundWorkloadKeyListLimit(Number.NaN)).toBe(1);
		expect(boundWorkloadKeyListLimit(1.5)).toBe(1);
		expect(boundWorkloadKeyListLimit(25)).toBe(25);
		expect(boundWorkloadKeyListLimit(100)).toBe(100);
		expect(boundWorkloadKeyListLimit(1000)).toBe(100);
	});

	it('accepts bounded printable idempotency keys only', () => {
		expect(isWorkloadKeyIdempotencyKey('create-ci-agent-1')).toBe(true);
		expect(isWorkloadKeyIdempotencyKey('a')).toBe(true);
		expect(isWorkloadKeyIdempotencyKey('a'.repeat(200))).toBe(true);
		expect(isWorkloadKeyIdempotencyKey('a'.repeat(201))).toBe(false);
		expect(isWorkloadKeyIdempotencyKey('')).toBe(false);
		expect(isWorkloadKeyIdempotencyKey('has space')).toBe(false);
		expect(isWorkloadKeyIdempotencyKey('line\nbreak')).toBe(false);
		expect(isWorkloadKeyIdempotencyKey('日本語')).toBe(false);
	});

	it('accepts canonical lowercase hyphenated UUID key ids only', () => {
		expect(isWorkloadKeyId('01900000-0000-7000-8000-000000000201')).toBe(true);
		expect(isWorkloadKeyId('01900000-0000-7000-8000-00000000020G')).toBe(false);
		expect(isWorkloadKeyId('01900000-0000-7000-8000-00000000020A')).toBe(false);
		expect(isWorkloadKeyId('01900000000070008000000000000201')).toBe(false);
		expect(isWorkloadKeyId('')).toBe(false);
		expect(isWorkloadKeyId(' 01900000-0000-7000-8000-000000000201')).toBe(false);
	});

	it('serializes and parses only byte-exact canonical scope lists', () => {
		expect(workloadKeyScopesJson(['envelopes:send', 'audit:read'])).toBe(
			'["audit:read","envelopes:send"]'
		);
		expect(parseWorkloadKeyScopesJson('["audit:read","envelopes:send"]')).toEqual([
			'audit:read',
			'envelopes:send'
		]);
		expect(
			parseWorkloadKeyScopesJson('["audit:read","drafts:write","envelopes:read","envelopes:send"]')
		).toEqual(['audit:read', 'drafts:write', 'envelopes:read', 'envelopes:send']);
	});

	it('fails closed on drifted, duplicated, unknown, empty, or malformed stored scopes', () => {
		expect(parseWorkloadKeyScopesJson('["envelopes:send","audit:read"]')).toBeNull();
		expect(parseWorkloadKeyScopesJson('["audit:read", "envelopes:send"]')).toBeNull();
		expect(parseWorkloadKeyScopesJson('["audit:read","audit:read"]')).toBeNull();
		expect(parseWorkloadKeyScopesJson('["envelopes:write"]')).toBeNull();
		expect(parseWorkloadKeyScopesJson('[]')).toBeNull();
		expect(parseWorkloadKeyScopesJson('["audit:read",1]')).toBeNull();
		expect(parseWorkloadKeyScopesJson('{"scopes":["audit:read"]}')).toBeNull();
		expect(parseWorkloadKeyScopesJson('not json')).toBeNull();
	});

	it('round-trips every single scope', () => {
		const scopes: readonly WorkloadKeyScope[] = [
			'audit:read',
			'drafts:write',
			'envelopes:read',
			'envelopes:send'
		];
		for (const scope of scopes) {
			expect(parseWorkloadKeyScopesJson(workloadKeyScopesJson([scope]))).toEqual([scope]);
		}
	});
});
