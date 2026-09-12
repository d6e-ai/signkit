import { describe, expect, it } from 'vitest';
import {
	BEARER_SECRET_PATTERN,
	isStrictSecret,
	parseBearerSecret,
	secretsEqual
} from './bearer-secret';

describe('bearer-secret utilities', () => {
	it('parses valid Bearer authorization headers with 32 to 200 printable ASCII characters', () => {
		const validSecret = 'a'.repeat(32);
		expect(parseBearerSecret(`Bearer ${validSecret}`)).toBe(validSecret);
		const maxSecret = 'x'.repeat(200);
		expect(parseBearerSecret(`Bearer ${maxSecret}`)).toBe(maxSecret);
		const printableAscii = '!@#$%^&*()_+-=[]{}|;:,.<>?~`';
		const mixedSecret = (printableAscii + '0123456789abcdef').slice(0, 32);
		expect(parseBearerSecret(`Bearer ${mixedSecret}`)).toBe(mixedSecret);
	});

	it('rejects invalid or malformed Bearer authorization headers', () => {
		expect(parseBearerSecret(null)).toBeNull();
		expect(parseBearerSecret('')).toBeNull();
		expect(parseBearerSecret('Basic 12345678901234567890123456789012')).toBeNull();
		expect(parseBearerSecret('Bearer')).toBeNull();
		expect(parseBearerSecret('Bearer ')).toBeNull();
		expect(parseBearerSecret(`Bearer ${'a'.repeat(31)}`)).toBeNull(); // too short
		expect(parseBearerSecret(`Bearer ${'a'.repeat(201)}`)).toBeNull(); // too long
		expect(parseBearerSecret(`Bearer  ${'a'.repeat(32)}`)).toBeNull(); // leading space
		expect(parseBearerSecret(`Bearer ${'a'.repeat(32)} `)).toBeNull(); // trailing space
		expect(parseBearerSecret(`Bearer ${'a'.repeat(32)}\n`)).toBeNull();
		expect(parseBearerSecret(`Bearer secret with spaces 12345678901234`)).toBeNull();
	});

	it('compares secrets in constant time and returns equality', async () => {
		const secret = 'correct-horse-battery-staple-12345678';
		expect(await secretsEqual(secret, secret)).toBe(true);
		expect(await secretsEqual(secret, 'wrong-horse-battery-staple-12345678')).toBe(false);
		expect(await secretsEqual(secret, 'short')).toBe(false);
		expect(await secretsEqual('short', secret)).toBe(false);
	});

	it('validates strict secret pattern', () => {
		expect(isStrictSecret(undefined)).toBe(false);
		expect(isStrictSecret('short')).toBe(false);
		expect(isStrictSecret('a'.repeat(32))).toBe(true);
		expect(isStrictSecret('a'.repeat(200))).toBe(true);
		expect(isStrictSecret('a'.repeat(201))).toBe(false);
		expect(BEARER_SECRET_PATTERN.test('hello world with spaces 1234567890')).toBe(false);
	});
});
