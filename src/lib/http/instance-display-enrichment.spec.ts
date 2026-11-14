import { describe, expect, it, vi } from 'vitest';
import type { InstanceMemberMetadata } from '$lib/ports/instance-store';
import { enrichInvitationDisplays, enrichMemberDisplays } from './instance-display-enrichment';

const NOW: string = '2026-09-12T12:00:00.000Z';

describe('instance display enrichment fallbacks', () => {
	it('keeps __proto__ and constructor as own fallback keys', async () => {
		const members: InstanceMemberMetadata[] = [
			{
				userId: '__proto__',
				role: 'member',
				status: 'active',
				createdAt: NOW,
				updatedAt: NOW
			},
			{
				userId: 'constructor',
				role: 'member',
				status: 'active',
				createdAt: NOW,
				updatedAt: NOW
			}
		];
		const displays = await enrichMemberDisplays(
			(): never => {
				throw new Error('sealed display unavailable');
			},
			undefined,
			'owner-1',
			members
		);
		expect(displays).toBeDefined();
		expect(Object.getPrototypeOf(displays)).toBeNull();
		expect(Object.hasOwn(displays!, '__proto__')).toBe(true);
		expect(Object.hasOwn(displays!, 'constructor')).toBe(true);
		expect(displays!['__proto__']).toEqual({ state: 'unavailable' });
		expect(JSON.parse(JSON.stringify(displays))['__proto__']).toEqual({ state: 'unavailable' });
	});

	it('keeps invitation fallback maps null-prototype for constructor ids', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		try {
			const displays = await enrichInvitationDisplays(async () => null, undefined, 'owner-1', [
				{
					id: 'constructor',
					role: 'member',
					status: 'pending',
					invitedByUserId: 'owner-1',
					createdAt: NOW,
					expiresAt: '2026-09-19T12:00:00.000Z',
					acceptedAt: null,
					acceptedByUserId: null,
					revokedAt: null,
					revokedByUserId: null
				}
			]);
			expect(Object.getPrototypeOf(displays)).toBeNull();
			expect(displays?.['constructor']).toEqual({ state: 'unavailable' });
		} finally {
			errorSpy.mockRestore();
		}
	});
});
