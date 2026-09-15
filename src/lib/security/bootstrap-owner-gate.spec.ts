import { describe, expect, it } from 'vitest';
import {
	isLocalDevelopmentBootstrapEnvironment,
	isUnsafeBootstrapOptIn,
	resolveBootstrapOwnerGate
} from './bootstrap-owner-gate';

describe('resolveBootstrapOwnerGate', () => {
	it('allows the exact configured owner email (case-insensitive, trimmed)', () => {
		expect(
			resolveBootstrapOwnerGate({
				configuredEmail: 'Owner@Example.com ',
				actorEmail: 'owner@example.com'
			})
		).toBe('allowed');
	});

	it('refuses a mismatched caller without consuming the claim window', () => {
		expect(
			resolveBootstrapOwnerGate({
				configuredEmail: 'owner@example.com',
				actorEmail: 'intruder@example.com'
			})
		).toBe('owner_mismatch');
	});

	it('fails closed when no owner email is configured and no unsafe opt-in applies', () => {
		expect(
			resolveBootstrapOwnerGate({ configuredEmail: undefined, actorEmail: 'any@example.com' })
		).toBe('owner_required');
		expect(
			resolveBootstrapOwnerGate({ configuredEmail: '   ', actorEmail: 'any@example.com' })
		).toBe('owner_required');
	});

	it('allows first-user bootstrap only when the unsafe opt-in is honored locally', () => {
		expect(
			resolveBootstrapOwnerGate({
				configuredEmail: undefined,
				actorEmail: 'dev@example.com',
				unsafeOptIn: true,
				localDevelopment: true
			})
		).toBe('allowed');
	});

	it('ignores the unsafe flag outside local development', () => {
		expect(
			resolveBootstrapOwnerGate({
				configuredEmail: undefined,
				actorEmail: 'stranger@example.com',
				unsafeOptIn: true,
				localDevelopment: false
			})
		).toBe('owner_required');
	});

	it('ignores a locally-running but flagless instance', () => {
		expect(
			resolveBootstrapOwnerGate({
				configuredEmail: undefined,
				actorEmail: 'dev@example.com',
				unsafeOptIn: false,
				localDevelopment: true
			})
		).toBe('owner_required');
	});

	it('prefers the configured email over the unsafe flag', () => {
		expect(
			resolveBootstrapOwnerGate({
				configuredEmail: 'owner@example.com',
				actorEmail: 'intruder@example.com',
				unsafeOptIn: true,
				localDevelopment: true
			})
		).toBe('owner_mismatch');
	});
});

describe('isUnsafeBootstrapOptIn', () => {
	it('accepts only exactly true after trimming', () => {
		expect(isUnsafeBootstrapOptIn('true')).toBe(true);
		expect(isUnsafeBootstrapOptIn(' true ')).toBe(true);
		expect(isUnsafeBootstrapOptIn('TRUE')).toBe(false);
		expect(isUnsafeBootstrapOptIn('True')).toBe(false);
		expect(isUnsafeBootstrapOptIn(' TRUE ')).toBe(false);
		expect(isUnsafeBootstrapOptIn(undefined)).toBe(false);
		expect(isUnsafeBootstrapOptIn('')).toBe(false);
		expect(isUnsafeBootstrapOptIn('1')).toBe(false);
		expect(isUnsafeBootstrapOptIn('yes')).toBe(false);
		expect(isUnsafeBootstrapOptIn('false')).toBe(false);
	});
});

describe('isLocalDevelopmentBootstrapEnvironment', () => {
	it('accepts loopback origins on Node without a platform env', () => {
		for (const origin of [
			'http://localhost:5173',
			'http://127.0.0.1:5173',
			'http://[::1]:5173',
			'https://localhost'
		]) {
			expect(
				isLocalDevelopmentBootstrapEnvironment({
					hasPlatformEnv: false,
					publicOrigin: origin
				})
			).toBe(true);
		}
	});

	it('refuses Cloudflare Workers even with a loopback origin', () => {
		expect(
			isLocalDevelopmentBootstrapEnvironment({
				hasPlatformEnv: true,
				publicOrigin: 'http://localhost:5173'
			})
		).toBe(false);
	});

	it('refuses Vercel even with a loopback origin', () => {
		for (const vercel of ['1', 'true']) {
			expect(
				isLocalDevelopmentBootstrapEnvironment({
					hasPlatformEnv: false,
					vercelIndicator: vercel,
					publicOrigin: 'http://localhost:5173'
				})
			).toBe(false);
		}
	});

	it('refuses production origins, missing origins, and malformed values', () => {
		for (const origin of [
			undefined,
			'',
			'   ',
			'not-a-url',
			'https://sign.example.com',
			'https://signkit.example.workers.dev'
		]) {
			expect(
				isLocalDevelopmentBootstrapEnvironment({ hasPlatformEnv: false, publicOrigin: origin })
			).toBe(false);
		}
	});
});
