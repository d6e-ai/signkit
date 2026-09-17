import type { Cookies } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipientWorkspace } from '$lib/application/signing/recipient-workspace';
import { declinedReceiptCookieName } from '$lib/server/declined-receipt-session';
import { recipientSessionCookieName } from '$lib/server/recipient-session';

const envelopeA: string = '01910000-0000-7000-8000-000000000001';
const envelopeB: string = '01910000-0000-7000-8000-000000000011';
const cookieA: string = recipientSessionCookieName(envelopeA) as string;
const cookieB: string = recipientSessionCookieName(envelopeB) as string;

const workspaceFor = (envelopeId: string): RecipientWorkspace => ({
	access: {
		envelopeId,
		recipientId: '01910000-0000-7000-8000-000000000002',
		recipientName: 'Alex Rivera',
		role: 'signer',
		locale: 'en',
		recipientStatus: 'pending',
		envelopeTitle: 'Agreement',
		envelopeStatus: 'sent',
		expiresAt: '2026-09-12T00:00:00.000Z'
	},
	documents: [
		{
			documentId: 'legacy',
			position: 0,
			title: 'agreement',
			kind: 'legacy',
			pageCount: 1,
			pageWidth: 595.28,
			pageHeight: 841.89
		}
	],
	source: 'legacy' as const,
	fields: [],
	fieldGeneration: 1
});

const resolveWorkspace = vi.fn();
const resolveDeclined = vi.fn();
const unsealActive = vi.fn();
const unsealDeclined = vi.fn();

vi.mock('$lib/application/signing/runtime', () => ({
	resolveRecipientWorkspaceApplication: () => ({
		resolve: resolveWorkspace
	}),
	resolveRecipientDeclinedReceiptApplication: () => ({
		recoverByToken: resolveDeclined,
		resolveLocator: resolveDeclined
	})
}));

vi.mock('$lib/server/recipient-session', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/recipient-session')>(
		'$lib/server/recipient-session'
	);
	return {
		...actual,
		unsealRecipientSession: (cookie: string, envelopeId: string) => unsealActive(cookie, envelopeId)
	};
});

vi.mock('$lib/server/declined-receipt-session', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/declined-receipt-session')>(
		'$lib/server/declined-receipt-session'
	);
	return {
		...actual,
		unsealDeclinedReceiptSession: (cookie: string, envelopeId: string) =>
			unsealDeclined(cookie, envelopeId),
		sealDeclinedReceiptSession: async () => 'sealed-declined-receipt'
	};
});

const { load } = await import('./+page.server');

function cookiesStore(initial: Record<string, string>): {
	cookies: Cookies;
	deleted: string[];
	store: Record<string, string>;
} {
	const store: Record<string, string> = { ...initial };
	const deleted: string[] = [];
	const cookies = {
		get: (name: string): string | undefined => store[name],
		delete: (name: string): void => {
			deleted.push(name);
			delete store[name];
		},
		set: (name: string, value: string): void => {
			store[name] = value;
		}
	} as unknown as Cookies;
	return { cookies, deleted, store };
}

function event(envelopeId: string, cookieMap: Record<string, string> = {}) {
	const { cookies, deleted, store } = cookiesStore(cookieMap);
	return {
		cookies,
		deleted,
		store,
		params: { envelopeId },
		platform: { env: { DB: {} as D1Database } },
		setHeaders: vi.fn(),
		url: new URL(`https://signkit.example/en/sign/${envelopeId}`)
	};
}

describe('envelope-scoped signing page load', () => {
	beforeEach((): void => {
		resolveWorkspace.mockReset();
		resolveDeclined.mockReset();
		unsealActive.mockReset();
		unsealDeclined.mockReset();
		resolveDeclined.mockResolvedValue(null);
	});

	it('reloads from the envelope-scoped cookie without exposing a capability token', async () => {
		unsealActive.mockResolvedValue(`skr1_${'A'.repeat(43)}`);
		resolveWorkspace.mockResolvedValue(workspaceFor(envelopeA));
		const input = event(envelopeA, { [cookieA]: 'sealed-a' });

		const page = await load(input as never);

		expect(page).toMatchObject({ state: 'active', access: { envelopeId: envelopeA } });
		expect(unsealActive).toHaveBeenCalledWith('sealed-a', envelopeA);
		expect(JSON.stringify(page)).not.toMatch(/skr1_/);
		expect(input.deleted).not.toContain(cookieB);
	});

	it('lets two envelope cookies coexist and resolve independently', async () => {
		unsealActive.mockImplementation(async (cookie: string, envelopeId: string) => {
			if (cookie === 'sealed-a' && envelopeId === envelopeA) return `skr1_${'A'.repeat(43)}`;
			if (cookie === 'sealed-b' && envelopeId === envelopeB) return `skr1_${'B'.repeat(43)}`;
			return null;
		});
		resolveWorkspace.mockImplementation(async (token: string) => {
			if (token === `skr1_${'A'.repeat(43)}`) return workspaceFor(envelopeA);
			if (token === `skr1_${'B'.repeat(43)}`) return workspaceFor(envelopeB);
			return null;
		});
		const shared = {
			[cookieA]: 'sealed-a',
			[cookieB]: 'sealed-b'
		};
		const first = event(envelopeA, shared);
		const second = event(envelopeB, shared);

		await expect(load(first as never)).resolves.toMatchObject({
			state: 'active',
			access: { envelopeId: envelopeA }
		});
		await expect(load(second as never)).resolves.toMatchObject({
			state: 'active',
			access: { envelopeId: envelopeB }
		});
		expect(first.deleted).not.toContain(cookieB);
		expect(first.deleted).not.toContain(declinedReceiptCookieName(envelopeB));
		expect(second.deleted).not.toContain(cookieA);
		expect(second.deleted).not.toContain(declinedReceiptCookieName(envelopeA));
		expect(first.store[cookieB]).toBe('sealed-b');
		expect(second.store[cookieA]).toBe('sealed-a');
	});

	it('does not delete a same-envelope cookie when a stale unreadable session fails', async () => {
		const input = event(envelopeA, { [cookieA]: 'stale' });
		unsealActive.mockImplementation(async () => {
			input.store[cookieA] = 'newer-from-s';
			return null;
		});
		unsealDeclined.mockResolvedValue(null);

		const page = await load(input as never);

		expect(page).toEqual({ state: 'invalid' });
		expect(input.deleted).toEqual([]);
		expect(input.store[cookieA]).toBe('newer-from-s');
	});

	it('does not delete a same-envelope cookie when durable access is gone', async () => {
		const input = event(envelopeA, { [cookieA]: 'stale' });
		unsealActive.mockResolvedValue(`skr1_${'A'.repeat(43)}`);
		resolveWorkspace.mockImplementation(async () => {
			input.store[cookieA] = 'newer-from-s';
			return null;
		});
		unsealDeclined.mockResolvedValue(null);

		const page = await load(input as never);

		expect(page).toEqual({ state: 'invalid' });
		expect(input.deleted).toEqual([]);
		expect(input.store[cookieA]).toBe('newer-from-s');
	});

	it('does not delete a declined receipt cookie after a successful active load', async () => {
		const declinedName: string = declinedReceiptCookieName(envelopeA) as string;
		unsealActive.mockResolvedValue(`skr1_${'A'.repeat(43)}`);
		resolveWorkspace.mockResolvedValue(workspaceFor(envelopeA));
		const input = event(envelopeA, {
			[cookieA]: 'sealed-a',
			[declinedName]: 'stale-declined'
		});

		const page = await load(input as never);

		expect(page).toMatchObject({ state: 'active', access: { envelopeId: envelopeA } });
		expect(input.deleted).toEqual([]);
		expect(input.store[declinedName]).toBe('stale-declined');
		expect(input.store[cookieA]).toBe('sealed-a');
	});

	it('recovers a declined receipt by overwrite without deleting a newer live cookie', async () => {
		const declinedName: string = declinedReceiptCookieName(envelopeA) as string;
		const input = event(envelopeA, { [cookieA]: 'stale' });
		unsealActive.mockResolvedValue(`skr1_${'A'.repeat(43)}`);
		resolveDeclined.mockImplementation(async () => {
			input.store[cookieA] = 'newer-from-s';
			return {
				receipt: {
					envelopeId: envelopeA,
					recipientId: '01910000-0000-7000-8000-000000000002',
					recipientStatus: 'declined',
					envelopeStatus: 'declined',
					declinedAt: '2026-09-11T00:02:00.000Z',
					locale: 'en'
				},
				locator: {
					envelopeId: envelopeA,
					recipientId: '01910000-0000-7000-8000-000000000002',
					idempotencyKey: 'decline-1',
					capabilityHash: 'b'.repeat(64),
					declinedAt: '2026-09-11T00:02:00.000Z',
					expiresAt: '2026-10-11T00:02:00.000Z'
				}
			};
		});
		const page = await load(input as never);

		expect(page).toMatchObject({ state: 'declined', envelopeId: envelopeA });
		expect(input.deleted).not.toContain(cookieA);
		expect(input.store[cookieA]).toBe('newer-from-s');
		expect(input.store[declinedName]).toBe('sealed-declined-receipt');
	});

	it('fails closed for a non-UUIDv7 path without reading cookies', async () => {
		const input = event('not-a-uuid', { [cookieA]: 'sealed-a' });
		const page = await load(input as never);
		expect(page).toEqual({ state: 'invalid' });
		expect(unsealActive).not.toHaveBeenCalled();
		expect(unsealDeclined).not.toHaveBeenCalled();
	});

	it('does not use envelope B cookie when loading envelope A', async () => {
		unsealActive.mockResolvedValue(null);
		unsealDeclined.mockResolvedValue(null);
		const input = event(envelopeA, { [cookieB]: 'sealed-b' });
		const page = await load(input as never);
		expect(page).toEqual({ state: 'invalid' });
		expect(unsealActive).not.toHaveBeenCalled();
		expect(input.deleted).not.toContain(cookieB);
		expect(input.deleted).not.toContain(declinedReceiptCookieName(envelopeB));
	});

	it('does not delete a declined receipt cookie when a stale locator fails', async () => {
		const declinedName: string = declinedReceiptCookieName(envelopeA) as string;
		const input = event(envelopeA, { [declinedName]: 'stale-declined' });
		unsealDeclined.mockImplementation(async () => {
			input.store[declinedName] = 'newer-receipt';
			return null;
		});

		const page = await load(input as never);

		expect(page).toEqual({ state: 'invalid' });
		expect(input.deleted).toEqual([]);
		expect(input.store[declinedName]).toBe('newer-receipt');
	});
});
