import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedPrincipal } from './d6e-auth';
import { SESSION_COOKIE, seal, unseal, type Session } from './session';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

const captureMemberSnapshot = vi.hoisted(() => vi.fn());
const resolveInstanceDisplayApplication = vi.hoisted(() =>
	vi.fn(async () => ({
		captureMemberSnapshot,
		memberDisplays: vi.fn(),
		invitationDisplays: vi.fn()
	}))
);
vi.mock('$lib/application/instance-display/instance-display-runtime', () => ({
	resolveInstanceDisplayApplication
}));

const { bestEffortCaptureMemberDisplay, INSTANCE_DISPLAY_CAPTURE_FAILED_CODE } =
	await import('./instance-display-capture');

const PRINCIPAL: VerifiedPrincipal = {
	subject: 'user-1',
	email: 'user@example.com',
	name: 'User',
	emailVerified: true
};
const OBSERVED_AT: string = '2026-09-12T12:00:00.000Z';

interface CookieJar {
	get(name: string): string | undefined;
	set(name: string, value: string): void;
	store: Map<string, string>;
}

function cookieJar(initial: Record<string, string> = {}): CookieJar {
	const store: Map<string, string> = new Map(Object.entries(initial));
	return {
		store,
		get: (name: string): string | undefined => store.get(name),
		set: (name: string, value: string): void => {
			store.set(name, value);
		}
	};
}

function session(overrides: Partial<Session> = {}): Session {
	return {
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		expiresAt: Math.floor(Date.now() / 1000) + 3600,
		principal: PRINCIPAL,
		profileObservedAt: OBSERVED_AT,
		...overrides
	};
}

beforeEach((): void => {
	privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
	captureMemberSnapshot.mockReset();
	captureMemberSnapshot.mockResolvedValue({ outcome: 'recorded' });
	resolveInstanceDisplayApplication.mockClear();
	resolveInstanceDisplayApplication.mockResolvedValue({
		captureMemberSnapshot,
		memberDisplays: vi.fn(),
		invitationDisplays: vi.fn()
	});
});

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('bestEffortCaptureMemberDisplay', () => {
	it('records a self snapshot from the original observation and sets the cookie marker', async () => {
		const cookies = cookieJar();
		const updated = await bestEffortCaptureMemberDisplay({
			cookies,
			url: new URL('https://signkit.example/envelopes'),
			session: session(),
			memberUserId: PRINCIPAL.subject,
			principal: PRINCIPAL
		});
		expect(captureMemberSnapshot).toHaveBeenCalledWith({
			userId: PRINCIPAL.subject,
			name: PRINCIPAL.name,
			email: PRINCIPAL.email,
			observedAt: OBSERVED_AT,
			storedAt: expect.any(String)
		});
		expect(updated?.profileStoredAt).toBe(OBSERVED_AT);
		const opened = await unseal(cookies.get(SESSION_COOKIE)!);
		expect(opened?.session.profileObservedAt).toBe(OBSERVED_AT);
		expect(opened?.session.profileStoredAt).toBe(OBSERVED_AT);
	});

	it('skips encryption when the cookie marker already matches the observation', async () => {
		const cookies = cookieJar();
		await bestEffortCaptureMemberDisplay({
			cookies,
			url: new URL('https://signkit.example/envelopes'),
			session: session({ profileStoredAt: OBSERVED_AT }),
			memberUserId: PRINCIPAL.subject,
			principal: PRINCIPAL
		});
		expect(resolveInstanceDisplayApplication).not.toHaveBeenCalled();
		expect(captureMemberSnapshot).not.toHaveBeenCalled();
	});

	it('does not invent an observation from membership timestamps or request time', async () => {
		const cookies = cookieJar({
			[SESSION_COOKIE]: await seal(session({ profileObservedAt: undefined }))
		});
		const updated = await bestEffortCaptureMemberDisplay({
			cookies,
			url: new URL('https://signkit.example/envelopes'),
			memberUserId: PRINCIPAL.subject,
			principal: PRINCIPAL
		});
		expect(captureMemberSnapshot).not.toHaveBeenCalled();
		expect(updated?.profileObservedAt).toBeUndefined();
	});

	it('never throws and logs only a fixed redacted code when capture fails', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		captureMemberSnapshot.mockRejectedValueOnce(
			new Error('ciphertext exploded for user@example.com token=ski1_secret')
		);
		const cookies = cookieJar();
		const updated = await bestEffortCaptureMemberDisplay({
			cookies,
			url: new URL('https://signkit.example/envelopes'),
			session: session(),
			memberUserId: PRINCIPAL.subject,
			principal: PRINCIPAL
		});
		expect(updated?.profileObservedAt).toBe(OBSERVED_AT);
		expect(updated?.profileStoredAt).toBeUndefined();
		expect(JSON.stringify(errorSpy.mock.calls)).toContain(INSTANCE_DISPLAY_CAPTURE_FAILED_CODE);
		expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('user@example.com');
		expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('ski1_secret');
		errorSpy.mockRestore();
	});
});
