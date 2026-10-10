import { Buffer } from 'node:buffer';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

const runtime = vi.hoisted(() => ({
	completedReceipt: null as RecipientCompletedReceiptApplicationPort | null
}));
vi.mock('$lib/application/signing/runtime', () => ({
	resolveRecipientWorkspaceApplication: () => null,
	resolveRecipientDeclinedReceiptApplication: () => null,
	resolveRecipientCompletedReceiptApplication: () => runtime.completedReceipt
}));

import type {
	RecipientApprovedApplicationPort,
	RecipientApprovedResult
} from '$lib/application/signing/recipient-approved';
import {
	RecipientCompletedReceiptApplication,
	type RecipientCompletedReceiptApplicationPort
} from '$lib/application/signing/recipient-completed-receipt';
import type {
	RecipientSignedApplicationPort,
	RecipientSignedResult
} from '$lib/application/signing/recipient-signed';
import { resolveRecipientCompletedReceiptApplication } from '$lib/application/signing/runtime';
import { createRecipientApprovedHandler } from '$lib/http/recipient-approved';
import { createRecipientSignedHandler } from '$lib/http/recipient-signed';
import type {
	ProvenRecipientCompletedReceipt,
	RecipientCompletedReceiptAction,
	RecipientCompletedReceiptEnvelopeStatus,
	RecipientCompletedReceiptIdentity,
	RecipientCompletedReceiptStore
} from '$lib/ports/recipient-completed-receipt-store';
import { hashRecipientCapability } from '$lib/security/recipient-capability';
import { completedReceiptCookieName } from '$lib/server/completed-receipt-session';
import {
	recipientSessionCookieName,
	sealRecipientSession,
	unsealRecipientSession
} from '$lib/server/recipient-session';

const { load } = await import('./+page.server');

const envelopeId: string = '01910000-0000-7000-8000-000000000001';
const recipientId: string = '01910000-0000-7000-8000-000000000002';
const otherEnvelopeId: string = '01910000-0000-7000-8000-000000000011';
const token: string = `skr1_${'A'.repeat(43)}`;
const origin: string = 'https://signkit.example';
const sessionCookie: string = recipientSessionCookieName(envelopeId) as string;
const receiptCookie: string = completedReceiptCookieName(envelopeId) as string;
const otherSessionCookie: string = recipientSessionCookieName(otherEnvelopeId) as string;

class InMemoryCompletedReceiptStore implements RecipientCompletedReceiptStore {
	constructor(private readonly record: ProvenRecipientCompletedReceipt) {}

	async findByCapabilityHash(
		capabilityHash: string
	): Promise<ProvenRecipientCompletedReceipt | null> {
		return this.record.capabilityHash === capabilityHash ? this.record : null;
	}

	async findByIdentity(
		identity: RecipientCompletedReceiptIdentity
	): Promise<ProvenRecipientCompletedReceipt | null> {
		return this.record.envelopeId === identity.envelopeId &&
			this.record.recipientId === identity.recipientId &&
			this.record.idempotencyKey === identity.idempotencyKey &&
			this.record.capabilityHash === identity.capabilityHash &&
			this.record.action === identity.action
			? this.record
			: null;
	}
}

interface CookieJar {
	cookies: Cookies;
	store: Record<string, string>;
}

function cookieJar(initial: Record<string, string>): CookieJar {
	const store: Record<string, string> = { ...initial };
	const cookies = {
		get: (name: string): string | undefined => store[name],
		set: (name: string, value: string): void => {
			store[name] = value;
		},
		delete: (name: string): void => {
			delete store[name];
		}
	} as unknown as Cookies;
	return { cookies, store };
}

function commandEvent(pathname: string, body: unknown, cookies: Cookies): RequestEvent {
	const request: Request = new Request(`${origin}${pathname}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin,
			'idempotency-key': 'terminal-action-1'
		},
		body: JSON.stringify(body)
	});
	return {
		cookies,
		platform: { env: { DB: {} as D1Database } },
		request,
		url: new URL(request.url)
	} as unknown as RequestEvent;
}

function reloadEvent(cookies: Cookies) {
	return {
		cookies,
		params: { envelopeId },
		platform: { env: { DB: {} as D1Database } },
		setHeaders: vi.fn(),
		url: new URL(`${origin}/en/sign/${envelopeId}`)
	};
}

async function stageEvidence(
	action: RecipientCompletedReceiptAction,
	completedAt: string,
	envelopeStatus: RecipientCompletedReceiptEnvelopeStatus
): Promise<void> {
	const record: ProvenRecipientCompletedReceipt = {
		envelopeId,
		recipientId,
		idempotencyKey: 'terminal-action-1',
		capabilityHash: await hashRecipientCapability(token),
		action,
		completedAt,
		envelopeStatus,
		envelopeCompletedByThisAction: false,
		locale: 'en'
	};
	runtime.completedReceipt = new RecipientCompletedReceiptApplication(
		new InMemoryCompletedReceiptStore(record)
	);
}

function signedApplication(signedAt: string): RecipientSignedApplicationPort {
	const result: RecipientSignedResult = {
		outcome: 'published',
		result: {
			envelopeId,
			recipientId,
			recipientRole: 'signer',
			routingOrder: 1,
			sentCommitSha: 'a'.repeat(40),
			envelopeStatus: 'in_progress',
			signedAt,
			auditEventId: 'private-audit-id',
			completedAuditEventId: null,
			nextRoutingOrder: null
		}
	};
	return { sign: async (): Promise<RecipientSignedResult> => result };
}

function approvedApplication(approvedAt: string): RecipientApprovedApplicationPort {
	const result: RecipientApprovedResult = {
		outcome: 'published',
		result: {
			envelopeId,
			recipientId,
			recipientRole: 'approver',
			routingOrder: 1,
			sentCommitSha: 'a'.repeat(40),
			envelopeStatus: 'in_progress',
			approvedAt,
			auditEventId: 'private-audit-id',
			completedAuditEventId: null,
			nextRoutingOrder: null
		}
	};
	return { approve: async (): Promise<RecipientApprovedResult> => result };
}

/** Runs the real browser terminal command and returns the cookie jar it left behind. */
async function postTerminalAction(
	action: RecipientCompletedReceiptAction,
	completedAt: string
): Promise<{ response: Response; jar: CookieJar }> {
	const jar: CookieJar = cookieJar({
		[sessionCookie]: await sealRecipientSession(token, envelopeId),
		[otherSessionCookie]: 'another-envelope-session',
		signkit_locale: 'en'
	});
	const receiptOptions = {
		resolveReceiptApplication: resolveRecipientCompletedReceiptApplication,
		allowInsecureLocalDevelopment: false
	};
	const response: Response =
		action === 'signed'
			? await createRecipientSignedHandler(
					() => signedApplication(completedAt),
					unsealRecipientSession,
					receiptOptions
				)(
					commandEvent(
						'/api/v1/signing/sign',
						{ envelopeId, recipientId, expectedFieldGeneration: 1, values: [] },
						jar.cookies
					)
				)
			: await createRecipientApprovedHandler(
					() => approvedApplication(completedAt),
					unsealRecipientSession,
					receiptOptions
				)(commandEvent('/api/v1/signing/approve', { envelopeId, recipientId }, jar.cookies));
	return { response, jar };
}

describe('terminal sign and approve to tokenless reload', () => {
	beforeEach((): void => {
		privateEnv.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
		runtime.completedReceipt = null;
	});

	it.each(['signed', 'approved'] as const)(
		'hands the %s recipient a read-only receipt the very next page load accepts',
		async (action: RecipientCompletedReceiptAction) => {
			const completedAt: string = new Date(Date.now() - 60_000).toISOString();
			await stageEvidence(action, completedAt, 'in_progress');

			const { response, jar } = await postTerminalAction(action, completedAt);

			expect(response.status).toBe(200);
			// The live capability is gone and a bounded read-only locator took its place.
			expect(jar.store[sessionCookie]).toBeUndefined();
			expect(jar.store[receiptCookie]).toBeDefined();
			// Unrelated cookies, including another envelope's live session, survive.
			expect(jar.store[otherSessionCookie]).toBe('another-envelope-session');
			expect(jar.store.signkit_locale).toBe('en');

			const page = await load(reloadEvent(jar.cookies) as never);

			expect(page).toMatchObject({
				state: 'completed',
				envelopeId,
				recipientId,
				recipientStatus: 'completed',
				action,
				envelopeStatus: 'in_progress'
			});
			expect(JSON.stringify(page)).not.toContain(token);
		}
	);

	it.each(['signed', 'approved'] as const)(
		'reloads a %s receipt again after a safe replay of the same command',
		async (action: RecipientCompletedReceiptAction) => {
			const completedAt: string = new Date(Date.now() - 60_000).toISOString();
			await stageEvidence(action, completedAt, 'in_progress');
			await postTerminalAction(action, completedAt);
			// A second tab replays the identical command against the same evidence.
			const { response, jar } = await postTerminalAction(action, completedAt);

			expect(response.status).toBe(200);
			expect(jar.store[receiptCookie]).toBeDefined();
			await expect(load(reloadEvent(jar.cookies) as never)).resolves.toMatchObject({
				state: 'completed',
				action
			});
		}
	);

	it('keeps the receipt when another recipient completed the envelope after this action', async () => {
		const completedAt: string = new Date(Date.now() - 60_000).toISOString();
		// The command result snapshot said `in_progress`; the durable evidence has
		// already moved on because a later recipient finished the envelope.
		await stageEvidence('signed', completedAt, 'completed');

		const { response, jar } = await postTerminalAction('signed', completedAt);

		expect(response.status).toBe(200);
		expect(jar.store[receiptCookie]).toBeDefined();
		await expect(load(reloadEvent(jar.cookies) as never)).resolves.toMatchObject({
			state: 'completed',
			action: 'signed',
			envelopeStatus: 'completed',
			envelopeCompletedByThisAction: false
		});
	});

	it('falls back to the generic invalid page when no receipt cookie was granted', async () => {
		const completedAt: string = new Date(Date.now() - 60_000).toISOString();
		await stageEvidence('signed', completedAt, 'in_progress');
		const { jar } = await postTerminalAction('signed', completedAt);
		delete jar.store[receiptCookie];

		await expect(load(reloadEvent(jar.cookies) as never)).resolves.toEqual({ state: 'invalid' });
	});

	it('grants no receipt cookie when the durable evidence does not match the command', async () => {
		const diagnostic = vi.spyOn(console, 'error').mockImplementation((): void => {});
		try {
			const completedAt: string = new Date(Date.now() - 60_000).toISOString();
			// Evidence for the other terminal action must never authorize this one.
			await stageEvidence('approved', completedAt, 'in_progress');

			const { response, jar } = await postTerminalAction('signed', completedAt);

			expect(response.status).toBe(200);
			expect(jar.store[receiptCookie]).toBeUndefined();
			expect(jar.store[sessionCookie]).toBeUndefined();
			await expect(load(reloadEvent(jar.cookies) as never)).resolves.toEqual({ state: 'invalid' });
			expect(diagnostic.mock.calls.map(String).join('|')).not.toContain(token);
		} finally {
			diagnostic.mockRestore();
		}
	});

	it('grants no receipt cookie when the sealing key is unavailable', async () => {
		const diagnostic = vi.spyOn(console, 'error').mockImplementation((): void => {});
		try {
			const completedAt: string = new Date(Date.now() - 60_000).toISOString();
			await stageEvidence('signed', completedAt, 'in_progress');
			const jar: CookieJar = cookieJar({
				[sessionCookie]: await sealRecipientSession(token, envelopeId)
			});
			delete privateEnv.SESSION_ENCRYPTION_KEY;

			const response: Response = await createRecipientSignedHandler(
				() => signedApplication(completedAt),
				async (): Promise<string> => token,
				{
					resolveReceiptApplication: resolveRecipientCompletedReceiptApplication,
					allowInsecureLocalDevelopment: false
				}
			)(
				commandEvent(
					'/api/v1/signing/sign',
					{ envelopeId, recipientId, expectedFieldGeneration: 1, values: [] },
					jar.cookies
				)
			);

			// A durable signature never reports failure over a receipt problem.
			expect(response.status).toBe(200);
			expect(jar.store[receiptCookie]).toBeUndefined();
			expect(jar.store[sessionCookie]).toBeUndefined();
			expect(diagnostic.mock.calls.map(String).join('|')).toContain(
				'recipient_completed_receipt_exchange_failed'
			);
		} finally {
			diagnostic.mockRestore();
		}
	});
});
