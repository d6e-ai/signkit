import { describe, expect, it } from 'vitest';
import {
	boundApiKeyListLimit,
	isApiKeyId,
	isApiKeyIdempotencyKey,
	parseApiKeyScopesJson,
	apiKeyScopesJson,
	MAX_API_KEY_LIST_LIMIT
} from './api-key-store';
import type { ApiKeyScope } from '$lib/security/api-key';

describe('api-key-store port helpers', () => {
	it('bounds the list limit to 1..100', () => {
		expect(MAX_API_KEY_LIST_LIMIT).toBe(100);
		expect(boundApiKeyListLimit(0)).toBe(1);
		expect(boundApiKeyListLimit(-10)).toBe(1);
		expect(boundApiKeyListLimit(Number.NaN)).toBe(1);
		expect(boundApiKeyListLimit(1.5)).toBe(1);
		expect(boundApiKeyListLimit(25)).toBe(25);
		expect(boundApiKeyListLimit(100)).toBe(100);
		expect(boundApiKeyListLimit(1000)).toBe(100);
	});

	it('accepts bounded printable idempotency keys only', () => {
		expect(isApiKeyIdempotencyKey('create-ci-agent-1')).toBe(true);
		expect(isApiKeyIdempotencyKey('a')).toBe(true);
		expect(isApiKeyIdempotencyKey('a'.repeat(200))).toBe(true);
		expect(isApiKeyIdempotencyKey('a'.repeat(201))).toBe(false);
		expect(isApiKeyIdempotencyKey('')).toBe(false);
		expect(isApiKeyIdempotencyKey('has space')).toBe(false);
		expect(isApiKeyIdempotencyKey('line\nbreak')).toBe(false);
		expect(isApiKeyIdempotencyKey('日本語')).toBe(false);
	});

	it('accepts canonical lowercase hyphenated UUID key ids only', () => {
		expect(isApiKeyId('01900000-0000-7000-8000-000000000201')).toBe(true);
		expect(isApiKeyId('01900000-0000-7000-8000-00000000020G')).toBe(false);
		expect(isApiKeyId('01900000-0000-7000-8000-00000000020A')).toBe(false);
		expect(isApiKeyId('01900000000070008000000000000201')).toBe(false);
		expect(isApiKeyId('')).toBe(false);
		expect(isApiKeyId(' 01900000-0000-7000-8000-000000000201')).toBe(false);
	});

	it('serializes and parses only byte-exact canonical scope lists', () => {
		expect(apiKeyScopesJson(['envelopes:send', 'audit:read'])).toBe(
			'["audit:read","envelopes:send"]'
		);
		expect(parseApiKeyScopesJson('["audit:read","envelopes:send"]')).toEqual([
			'audit:read',
			'envelopes:send'
		]);
		expect(
			parseApiKeyScopesJson('["audit:read","drafts:write","envelopes:read","envelopes:send"]')
		).toEqual(['audit:read', 'drafts:write', 'envelopes:read', 'envelopes:send']);
	});

	it('fails closed on drifted, duplicated, unknown, empty, or malformed stored scopes', () => {
		expect(parseApiKeyScopesJson('["envelopes:send","audit:read"]')).toBeNull();
		expect(parseApiKeyScopesJson('["audit:read", "envelopes:send"]')).toBeNull();
		expect(parseApiKeyScopesJson('["audit:read","audit:read"]')).toBeNull();
		expect(parseApiKeyScopesJson('["envelopes:write"]')).toBeNull();
		expect(parseApiKeyScopesJson('[]')).toBeNull();
		expect(parseApiKeyScopesJson('["audit:read",1]')).toBeNull();
		expect(parseApiKeyScopesJson('{"scopes":["audit:read"]}')).toBeNull();
		expect(parseApiKeyScopesJson('not json')).toBeNull();
	});

	it('round-trips every single scope', () => {
		const scopes: readonly ApiKeyScope[] = [
			'audit:read',
			'drafts:write',
			'envelopes:read',
			'envelopes:send'
		];
		for (const scope of scopes) {
			expect(parseApiKeyScopesJson(apiKeyScopesJson([scope]))).toEqual([scope]);
		}
	});
});
