import { describe, expect, it } from 'vitest';
import { ConsoleOriginsPolicyError, parseConsoleOrigins } from './console-origins';

describe('parseConsoleOrigins', () => {
	it.each([undefined, null, '', '   '])('turns the feature off for %j', (raw) => {
		expect(parseConsoleOrigins(raw)).toEqual(new Set());
	});

	it('canonicalizes exact origins into the form browsers send', () => {
		expect(
			parseConsoleOrigins(
				' https://Console.Example.com , https://console.example.com:8443/,http://localhost:5173,http://[::1]:4173'
			)
		).toEqual(
			new Set([
				'https://console.example.com',
				'https://console.example.com:8443',
				'http://localhost:5173',
				'http://[::1]:4173'
			])
		);
	});

	it.each([
		['a wildcard', '*'],
		['a wildcard host', 'https://*.example.com'],
		['the null origin', 'null'],
		['a bare host', 'console.example.com'],
		['a path', 'https://console.example.com/console'],
		['a query', 'https://console.example.com?x=1'],
		['an empty query', 'https://console.example.com?'],
		['a fragment', 'https://console.example.com#top'],
		['credentials', 'https://user:pass@console.example.com'],
		['plain HTTP on a public host', 'http://console.example.com'],
		['another scheme', 'ftp://console.example.com'],
		['an empty entry', 'https://console.example.com,,https://other.example.com']
	])('fails closed on %s', (_name, raw) => {
		expect(() => parseConsoleOrigins(raw)).toThrow(ConsoleOriginsPolicyError);
	});

	it('never echoes the configured value in its error', () => {
		const raw: string = 'https://secret-console.example.com/path';
		let message: string = '';
		try {
			parseConsoleOrigins(raw);
		} catch (error: unknown) {
			message = error instanceof Error ? error.message : '';
		}
		expect(message).not.toBe('');
		expect(message).not.toContain('secret-console');
	});
});
