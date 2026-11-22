import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedPrincipal } from './d6e-auth';

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

const {
	bestEffortCaptureMemberDisplay,
	displayCaptureSource,
	INSTANCE_DISPLAY_CAPTURE_FAILED_CODE
} = await import('./instance-display-capture');

const PRINCIPAL: VerifiedPrincipal = {
	subject: 'user-1',
	email: 'user@example.com',
	name: 'User',
	emailVerified: true
};
const OBSERVED_AT: string = '2026-09-12T12:00:00.000Z';

beforeEach((): void => {
	captureMemberSnapshot.mockReset();
	captureMemberSnapshot.mockResolvedValue({ outcome: 'recorded' });
	resolveInstanceDisplayApplication.mockClear();
	resolveInstanceDisplayApplication.mockResolvedValue({
		captureMemberSnapshot,
		memberDisplays: vi.fn(),
		invitationDisplays: vi.fn()
	});
});

function locals(accessTokenAuthentication: App.Locals['accessTokenAuthentication']): App.Locals {
	return { accessTokenAuthentication } as unknown as App.Locals;
}

describe('displayCaptureSource', () => {
	it('takes the observation from a verified access token only', () => {
		expect(displayCaptureSource(locals({ state: 'verified', observedAt: OBSERVED_AT }))).toEqual({
			accessTokenObservedAt: OBSERVED_AT
		});
		for (const state of [
			{ state: 'verified', observedAt: null },
			{ state: 'absent' },
			{ state: 'presented', token: 't' },
			{ state: 'rejected' },
			{ state: 'unavailable' }
		] as const) {
			expect(displayCaptureSource(locals(state))).toEqual({});
		}
	});
});

describe('bestEffortCaptureMemberDisplay', () => {
	it("records the member's own snapshot from the token observation", async () => {
		await bestEffortCaptureMemberDisplay({
			accessTokenObservedAt: OBSERVED_AT,
			memberUserId: PRINCIPAL.subject,
			principal: PRINCIPAL
		});
		expect(captureMemberSnapshot).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				userId: PRINCIPAL.subject,
				name: PRINCIPAL.name,
				email: PRINCIPAL.email,
				observedAt: OBSERVED_AT
			})
		);
	});

	it('captures nothing without an observation, for another member, or an unverified email', async () => {
		await bestEffortCaptureMemberDisplay({ memberUserId: PRINCIPAL.subject, principal: PRINCIPAL });
		await bestEffortCaptureMemberDisplay({
			accessTokenObservedAt: OBSERVED_AT,
			memberUserId: 'someone-else',
			principal: PRINCIPAL
		});
		await bestEffortCaptureMemberDisplay({
			accessTokenObservedAt: OBSERVED_AT,
			memberUserId: PRINCIPAL.subject,
			principal: { ...PRINCIPAL, emailVerified: false }
		});
		expect(captureMemberSnapshot).not.toHaveBeenCalled();
	});

	it('never throws and logs only a fixed redacted code when capture fails', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		captureMemberSnapshot.mockRejectedValueOnce(
			new Error('ciphertext exploded for user@example.com token=ski1_secret')
		);
		await expect(
			bestEffortCaptureMemberDisplay({
				accessTokenObservedAt: OBSERVED_AT,
				memberUserId: PRINCIPAL.subject,
				principal: PRINCIPAL
			})
		).resolves.toBeUndefined();
		const logged: string = JSON.stringify(errorSpy.mock.calls);
		expect(logged).toContain(INSTANCE_DISPLAY_CAPTURE_FAILED_CODE);
		expect(logged).not.toContain('user@example.com');
		expect(logged).not.toContain('ski1_secret');
		errorSpy.mockRestore();
	});
});
