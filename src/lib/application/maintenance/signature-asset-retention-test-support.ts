import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { drawnSignaturePng } from '$lib/adapters/pdf/png-image-test-support';
import { signatureAssetKey } from '$lib/application/documents/signature-asset';
import {
	RecipientSignedApplication,
	type RecipientSignedInput,
	type RecipientSignedResult
} from '$lib/application/signing/recipient-signed';
import type { ListObjectsOptions, ListObjectsResult } from '$lib/ports/object-store';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import type {
	PublishRecipientSignedCommand,
	PublishRecipientSignedResult,
	RecipientSignStore,
	SignLookupKey,
	SignPreparation
} from '$lib/ports/recipient-sign-store';
import type { SignatureAssetLedger, SignatureAssetScope } from '$lib/ports/signature-asset-ledger';
import {
	OrphanCollector,
	OrphanSweepFailure,
	type OrphanCollectorReport,
	type OrphanReferenceStore
} from './orphan-collector';

/** Shared identities every dialect harness seeds. */
export const RETENTION_ENVELOPE_ID: string = '01920019-0000-7000-8000-000000000001';
export const RETENTION_SIGNER_ID: string = '01920019-0000-7000-8000-000000000002';
export const RETENTION_FIELD_ID: string = '01920019-0000-7000-8000-00000000000a';
export const RETENTION_OTHER_ENVELOPE_ID: string = '01920019-0000-7000-8000-000000000101';
export const RETENTION_OTHER_RECIPIENT_ID: string = '01920019-0000-7000-8000-000000000102';
export const RETENTION_FIELD_GENERATION: number = 1;
export const RETENTION_SENT_AT: string = '2026-09-24T00:00:00.000Z';
export const RETENTION_VIEWED_AT: string = '2026-09-24T01:00:00.000Z';
export const RETENTION_CAPABILITY_EXPIRES_AT: string = '2026-10-08T00:00:00.000Z';

/** Sign time and sweep time. The sweep's 24h cutoff is therefore 2026-09-23T02:00Z. */
export const RETENTION_NOW: Date = new Date('2026-09-24T02:00:00.000Z');
/** Older than the sweep cutoff: an aged upload or an abandoned registration. */
export const RETENTION_AGED_AT: string = '2026-09-20T00:00:00.000Z';

export type RetentionFieldType = 'signature' | 'initials';

export interface RetentionHarness {
	ledger: SignatureAssetLedger;
	references: OrphanReferenceStore;
	signStore: RecipientSignStore;
	/**
	 * Seeds a sent envelope whose only (viewed) signer owns exactly one
	 * required field of `fieldType`, plus an unrelated envelope/recipient pair
	 * for scoped-owner checks. Returns the signer's capability token.
	 */
	seed(fieldType: RetentionFieldType): Promise<string>;
	publishedRows(): Promise<{ fieldValues: number; receipts: number }>;
	/** Every ledger row, in a stable order, for no-write assertions. */
	ledgerSnapshot(): Promise<string>;
	/** Directly forces `state` on an existing row, bypassing the adapter. */
	forceState(scope: SignatureAssetScope, state: 'pending' | 'bound' | 'retired'): Promise<void>;
}

/** In-memory object store that reports a provider upload time for each object. */
export class AgedObjectStore extends InMemoryObjectStore {
	readonly uploadedAt = new Map<string, string>();
	deleteFailures: 'none' | 'before_delete' | 'after_delete' = 'none';

	async list(options: ListObjectsOptions = {}): Promise<ListObjectsResult> {
		const listed: ListObjectsResult = await super.list(options);
		return {
			...listed,
			objects: listed.objects.map((object) => ({
				...object,
				uploadedAt: this.uploadedAt.get(object.key) ?? RETENTION_AGED_AT
			}))
		};
	}

	async deleteMany(keys: readonly string[]): Promise<void> {
		const failure = this.deleteFailures;
		this.deleteFailures = 'none';
		if (failure === 'before_delete') throw new Error('provider unavailable');
		await super.deleteMany(keys);
		if (failure === 'after_delete') throw new Error('provider response lost');
	}
}

/** Runs `beforePublish` between the application's verification and the store's publish. */
class BarrierSignStore implements RecipientSignStore {
	constructor(
		private readonly inner: RecipientSignStore,
		private readonly beforePublish: () => Promise<void>
	) {}

	prepareSign(key: SignLookupKey, at: string): Promise<SignPreparation> {
		return this.inner.prepareSign(key, at);
	}

	async publishSign(command: PublishRecipientSignedCommand): Promise<PublishRecipientSignedResult> {
		await this.beforePublish();
		return await this.inner.publishSign(command);
	}
}

export interface RetentionAsset {
	png: Uint8Array;
	scope: SignatureAssetScope;
	key: string;
	ref: string;
}

export function retentionAsset(): RetentionAsset {
	const png: Uint8Array = drawnSignaturePng();
	const sha256: string = createHash('sha256').update(png).digest('hex');
	return {
		png,
		scope: { envelopeId: RETENTION_ENVELOPE_ID, recipientId: RETENTION_SIGNER_ID, sha256 },
		key: signatureAssetKey(RETENTION_ENVELOPE_ID, RETENTION_SIGNER_ID, sha256),
		ref: `sig:sha256:${sha256}`
	};
}

function signInput(
	token: string,
	ref: string,
	idempotencyKey: string = 'sign-1'
): RecipientSignedInput {
	return {
		token,
		expectedEnvelopeId: RETENTION_ENVELOPE_ID,
		expectedRecipientId: RETENTION_SIGNER_ID,
		expectedFieldGeneration: RETENTION_FIELD_GENERATION,
		idempotencyKey,
		values: [{ fieldId: RETENTION_FIELD_ID, value: ref }]
	};
}

/**
 * The issue #219 race matrix, run unchanged against each dialect's real
 * ledger, reference store, and sign store. `harness` is called per test.
 */
export function defineSignatureRetentionScenarios(harness: () => RetentionHarness): void {
	function collector(h: RetentionHarness, objects: AgedObjectStore, now: Date = RETENTION_NOW) {
		return new OrphanCollector(objects, h.references, (): Date => now, null, h.ledger);
	}

	function signer(
		h: RetentionHarness,
		objects: AgedObjectStore,
		beforePublish: () => Promise<void> = async (): Promise<void> => undefined
	): RecipientSignedApplication {
		return new RecipientSignedApplication(
			new BarrierSignStore(h.signStore, beforePublish),
			(): Date => RETENTION_NOW,
			undefined,
			objects,
			h.ledger
		);
	}

	for (const fieldType of ['signature', 'initials'] as const) {
		it(`${fieldType}: a fresh signing touch wins over a sweep that runs before publish`, async () => {
			const h: RetentionHarness = harness();
			const token: string = await h.seed(fieldType);
			const asset: RetentionAsset = retentionAsset();
			const objects = new AgedObjectStore();
			objects.seed(asset.key, asset.png, asset.scope.sha256);
			expect(await h.ledger.registerPending(asset.scope, RETENTION_AGED_AT)).toBe('ok');
			let barrierReport: OrphanCollectorReport | null = null;

			const result: RecipientSignedResult = await signer(h, objects, async () => {
				barrierReport = await collector(h, objects).sweep();
			}).sign(signInput(token, asset.ref));

			expect(result.outcome).toBe('published');
			expect(barrierReport).toMatchObject({ deleted: 0, deletedKeys: [] });
			expect(objects.keys()).toEqual([asset.key]);
			expect(await h.ledger.checkFresh(asset.scope, RETENTION_NOW.toISOString())).toBe('bound');
			// Bound is final: a later sweep keeps it, and replay needs no asset read.
			expect((await collector(h, objects).sweep()).deleted).toBe(0);
			const replay: RecipientSignedResult = await signer(h, new AgedObjectStore()).sign(
				signInput(token, asset.ref)
			);
			expect(replay.outcome).toBe('replayed');
		});

		it(`${fieldType}: a committed retirement wins, so the fresh signing cannot publish`, async () => {
			const h: RetentionHarness = harness();
			const token: string = await h.seed(fieldType);
			const asset: RetentionAsset = retentionAsset();
			const objects = new AgedObjectStore();
			objects.seed(asset.key, asset.png, asset.scope.sha256);
			await h.ledger.registerPending(asset.scope, RETENTION_AGED_AT);

			const report: OrphanCollectorReport = await collector(h, objects).sweep();
			const result: RecipientSignedResult = await signer(h, objects).sign(
				signInput(token, asset.ref)
			);

			expect(report.deletedKeys).toEqual([asset.key]);
			expect(result).toEqual({ outcome: 'signature_asset_expired' });
			expect(await h.publishedRows()).toEqual({ fieldValues: 0, receipts: 0 });
			// Never resurrected: the same bytes are refused at upload.
			expect(await h.ledger.registerPending(asset.scope, RETENTION_NOW.toISOString())).toBe(
				'retired'
			);
		});

		it(`${fieldType}: a legacy asset retired between verification and publish is rejected atomically`, async () => {
			const h: RetentionHarness = harness();
			const token: string = await h.seed(fieldType);
			const asset: RetentionAsset = retentionAsset();
			const objects = new AgedObjectStore();
			objects.seed(asset.key, asset.png, asset.scope.sha256);

			const result: RecipientSignedResult = await signer(h, objects, async () => {
				const report: OrphanCollectorReport = await collector(h, objects).sweep();
				expect(report.deletedKeys).toEqual([asset.key]);
			}).sign(signInput(token, asset.ref));

			expect(result).toEqual({ outcome: 'signature_asset_expired' });
			expect(await h.publishedRows()).toEqual({ fieldValues: 0, receipts: 0 });
			expect(await h.ledger.checkFresh(asset.scope, RETENTION_NOW.toISOString())).toBe('retired');
		});

		it(`${fieldType}: a legacy asset published first is grandfathered in as bound and kept`, async () => {
			const h: RetentionHarness = harness();
			const token: string = await h.seed(fieldType);
			const asset: RetentionAsset = retentionAsset();
			const objects = new AgedObjectStore();
			objects.seed(asset.key, asset.png, asset.scope.sha256);

			const result: RecipientSignedResult = await signer(h, objects).sign(
				signInput(token, asset.ref)
			);
			const report: OrphanCollectorReport = await collector(h, objects).sweep();

			expect(result.outcome).toBe('published');
			expect(report.deleted).toBe(0);
			expect(await h.ledger.checkFresh(asset.scope, RETENTION_NOW.toISOString())).toBe('bound');
		});
	}

	it('retries a permanently retired object after a provider failure before deletion', async () => {
		const h: RetentionHarness = harness();
		await h.seed('signature');
		const asset: RetentionAsset = retentionAsset();
		const objects = new AgedObjectStore();
		objects.seed(asset.key, asset.png, asset.scope.sha256);
		await h.ledger.registerPending(asset.scope, RETENTION_AGED_AT);
		objects.deleteFailures = 'before_delete';

		await expect(collector(h, objects).sweep()).rejects.toMatchObject({
			code: 'object_delete_failed'
		});
		expect(objects.keys()).toEqual([asset.key]);
		expect(await h.ledger.registerPending(asset.scope, RETENTION_NOW.toISOString())).toBe(
			'retired'
		);

		const retry: OrphanCollectorReport = await collector(h, objects).sweep();
		expect(retry.deletedKeys).toEqual([asset.key]);
		expect(objects.size).toBe(0);
	});

	it('treats an ambiguous provider delete as retired and never reopens the key', async () => {
		const h: RetentionHarness = harness();
		const token: string = await h.seed('signature');
		const asset: RetentionAsset = retentionAsset();
		const objects = new AgedObjectStore();
		objects.seed(asset.key, asset.png, asset.scope.sha256);
		await h.ledger.registerPending(asset.scope, RETENTION_AGED_AT);
		objects.deleteFailures = 'after_delete';

		const failure: unknown = await collector(h, objects)
			.sweep()
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(OrphanSweepFailure);
		expect(objects.size).toBe(0);
		expect((await collector(h, objects).sweep()).deleted).toBe(0);
		// A late re-upload of the same bytes cannot rebind the deleted key.
		expect(await h.ledger.registerPending(asset.scope, RETENTION_NOW.toISOString())).toBe(
			'retired'
		);
		objects.seed(asset.key, asset.png, asset.scope.sha256);
		expect((await signer(h, objects).sign(signInput(token, asset.ref))).outcome).toBe(
			'signature_asset_expired'
		);
	});

	it('keeps an asset a stale worker would have collected once a fresh touch landed', async () => {
		const h: RetentionHarness = harness();
		await h.seed('initials');
		const asset: RetentionAsset = retentionAsset();
		const objects = new AgedObjectStore();
		objects.seed(asset.key, asset.png, asset.scope.sha256);
		await h.ledger.registerPending(asset.scope, RETENTION_AGED_AT);
		// The stale worker's listing and cutoff predate the re-upload touch below.
		expect(await h.ledger.registerPending(asset.scope, RETENTION_NOW.toISOString())).toBe('ok');

		const report: OrphanCollectorReport = await collector(h, objects).sweep();

		expect(report.deleted).toBe(0);
		expect(objects.keys()).toEqual([asset.key]);
		expect(await h.ledger.checkFresh(asset.scope, RETENTION_NOW.toISOString())).toBe('pending');
	});

	it('retires only abandoned registrations whose object is absent', async () => {
		const h: RetentionHarness = harness();
		await h.seed('signature');
		const abandoned: SignatureAssetScope = { ...retentionAsset().scope, sha256: '1'.repeat(64) };
		const freshAbandoned: SignatureAssetScope = { ...abandoned, sha256: '2'.repeat(64) };
		const youngObject: SignatureAssetScope = { ...abandoned, sha256: '3'.repeat(64) };
		const objects = new AgedObjectStore();
		const youngKey: string = signatureAssetKey(
			youngObject.envelopeId,
			youngObject.recipientId,
			youngObject.sha256
		);
		objects.seed(youngKey, new Uint8Array([1]));
		objects.uploadedAt.set(youngKey, RETENTION_NOW.toISOString());
		await h.ledger.registerPending(abandoned, RETENTION_AGED_AT);
		await h.ledger.registerPending(freshAbandoned, RETENTION_NOW.toISOString());
		await h.ledger.registerPending(youngObject, RETENTION_AGED_AT);

		const report: OrphanCollectorReport = await collector(h, objects).sweep();

		expect(report.retiredPendingRegistrations).toBe(1);
		expect(await h.ledger.registerPending(abandoned, RETENTION_NOW.toISOString())).toBe('retired');
		expect(await h.ledger.checkFresh(freshAbandoned, RETENTION_NOW.toISOString())).toBe('pending');
		expect(await h.ledger.checkFresh(youngObject, RETENTION_NOW.toISOString())).toBe('pending');
		expect(objects.keys()).toEqual([youngKey]);
	});

	it('dry-run predicts retirements without writing the ledger or deleting objects', async () => {
		const h: RetentionHarness = harness();
		await h.seed('signature');
		const asset: RetentionAsset = retentionAsset();
		const legacyKey: string = signatureAssetKey(
			asset.scope.envelopeId,
			asset.scope.recipientId,
			'4'.repeat(64)
		);
		const objects = new AgedObjectStore();
		objects.seed(asset.key, asset.png, asset.scope.sha256);
		objects.seed(legacyKey, new Uint8Array([1]));
		await h.ledger.registerPending(asset.scope, RETENTION_AGED_AT);
		await h.ledger.registerPending({ ...asset.scope, sha256: '5'.repeat(64) }, RETENTION_AGED_AT);
		const before: string = await h.ledgerSnapshot();

		const report: OrphanCollectorReport = await collector(h, objects).sweep({ dryRun: true });

		expect([...report.deletedKeys].sort()).toEqual([asset.key, legacyKey].sort());
		expect(report.retiredPendingRegistrations).toBe(1);
		expect(await h.ledgerSnapshot()).toBe(before);
		expect(objects.size).toBe(2);
	});

	it('rejects a ledger row whose recipient belongs to a different envelope', async () => {
		const h: RetentionHarness = harness();
		await h.seed('signature');
		await expect(
			h.ledger.registerPending(
				{
					envelopeId: RETENTION_ENVELOPE_ID,
					recipientId: RETENTION_OTHER_RECIPIENT_ID,
					sha256: '6'.repeat(64)
				},
				RETENTION_NOW.toISOString()
			)
		).rejects.toThrow();
	});

	it('enforces bound and retired as final states in the database', async () => {
		const h: RetentionHarness = harness();
		const token: string = await h.seed('signature');
		const asset: RetentionAsset = retentionAsset();
		const objects = new AgedObjectStore();
		objects.seed(asset.key, asset.png, asset.scope.sha256);
		await h.ledger.registerPending(asset.scope, RETENTION_AGED_AT);
		expect((await signer(h, objects).sign(signInput(token, asset.ref))).outcome).toBe('published');
		await expect(h.forceState(asset.scope, 'pending')).rejects.toThrow();
		await expect(h.forceState(asset.scope, 'retired')).rejects.toThrow();

		const retired: SignatureAssetScope = { ...asset.scope, sha256: '7'.repeat(64) };
		await h.ledger.registerPending(retired, RETENTION_AGED_AT);
		expect(
			await h.ledger.retireAbandonedPending(retired, RETENTION_AGED_AT, RETENTION_NOW.toISOString())
		).toBe(true);
		await expect(h.forceState(retired, 'pending')).rejects.toThrow();
		await expect(h.forceState(retired, 'bound')).rejects.toThrow();
	});

	it('collects an unreferenced legacy object whose recipient no longer exists without a tombstone', async () => {
		const h: RetentionHarness = harness();
		await h.seed('signature');
		const key: string = signatureAssetKey(
			RETENTION_OTHER_ENVELOPE_ID,
			'01920019-0000-7000-8000-0000000001ff',
			'8'.repeat(64)
		);
		const objects = new AgedObjectStore();
		objects.seed(key, new Uint8Array([1]));
		const before: string = await h.ledgerSnapshot();

		expect((await collector(h, objects).sweep()).deletedKeys).toEqual([key]);
		expect(await h.ledgerSnapshot()).toBe(before);
	});
}
