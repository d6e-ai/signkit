import { describe, expect, it } from 'vitest';
import {
	smokeCheck,
	smokeBackoffDelay,
	productionWorkersDevOrigin
} from '../src/providers/cloudflare/smoke.js';
import { FakeHttp } from './helpers.js';

const CAPABILITIES = JSON.stringify({ name: 'signkit', apiVersion: '1' });
const CUSTOM = 'https://sign.example.com/api/v1/system/capabilities';
const WORKERS_DEV = 'https://signkit.example.workers.dev/api/v1/system/capabilities';

describe('smoke retry and fallback', () => {
	it('retries transient failures and succeeds without waiting', async () => {
		const http = new FakeHttp();
		http.on(CUSTOM, 'down', 503);
		http.on(CUSTOM, CAPABILITIES, 200);
		const sleeps: number[] = [];
		const result = await smokeCheck({
			url: 'https://sign.example.com',
			http,
			attempts: 3,
			backoffMs: 25,
			sleep: async (ms) => {
				sleeps.push(ms);
			}
		});
		expect(result.ok).toBe(true);
		expect(sleeps).toEqual([25]);
		expect(http.requests).toHaveLength(2);
	});

	it('uses escalating nonzero backoff between transient failures', async () => {
		const http = new FakeHttp();
		http.on(CUSTOM, 'down', 503);
		http.on(CUSTOM, 'down', 503);
		http.on(CUSTOM, CAPABILITIES, 200);
		const sleeps: number[] = [];
		const result = await smokeCheck({
			url: 'https://sign.example.com',
			http,
			attempts: 3,
			backoffMs: 25,
			timeoutMs: 50,
			sleep: async (ms) => {
				sleeps.push(ms);
			}
		});
		expect(result.ok).toBe(true);
		expect(sleeps).toEqual([25, 50]);
		expect(smokeBackoffDelay(1, 1000)).toBe(1000);
		expect(smokeBackoffDelay(2, 1000)).toBe(2000);
		expect(smokeBackoffDelay(1, 0)).toBe(0);
	});

	it('passes a per-request timeout to the HTTP client', async () => {
		const http = new FakeHttp();
		http.on(CUSTOM, CAPABILITIES, 200);
		await smokeCheck({
			url: 'https://sign.example.com',
			http,
			attempts: 1,
			backoffMs: 0,
			timeoutMs: 1234,
			sleep: async () => undefined
		});
		expect(http.requests[0]?.timeoutMs).toBe(1234);
	});

	it('accepts only production workers.dev hostnames for the Worker name', () => {
		expect(productionWorkersDevOrigin('https://signkit.example.workers.dev', 'signkit')).toBe(
			'https://signkit.example.workers.dev'
		);
		expect(
			productionWorkersDevOrigin('https://22222222-signkit.example.workers.dev', 'signkit')
		).toBeUndefined();
	});

	it('falls back to the uploaded workers.dev origin when a custom domain is transiently unavailable', async () => {
		const http = new FakeHttp();
		http.on(CUSTOM, 'down', 404);
		http.on(CUSTOM, 'down', 404);
		http.on(WORKERS_DEV, CAPABILITIES, 200);
		const result = await smokeCheck({
			url: 'https://sign.example.com',
			fallbackUrl: 'https://signkit.example.workers.dev',
			http,
			attempts: 2,
			backoffMs: 0,
			sleep: async () => undefined
		});
		expect(result.ok).toBe(true);
		expect(result.usedFallback).toBe(true);
		expect(result.url).toBe(WORKERS_DEV);
		expect(http.requests.map((request) => request.url)).toEqual([CUSTOM, CUSTOM, WORKERS_DEV]);
		expect(http.requests.every((request) => request.allowedHosts.size === 1)).toBe(true);
	});
});
