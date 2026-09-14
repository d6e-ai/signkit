import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
	draftArchiveKey,
	DraftPersistenceService
} from '$lib/application/drafts/draft-persistence';
import type {
	DraftMutationStore,
	DraftRevisionPreparation,
	PublishDraftRevisionResult
} from '$lib/ports/draft-mutation-store';
import type { DraftDocument, DraftRepository, DraftVersion } from '$lib/ports/draft-repository';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import type { Envelope, Recipient } from '$lib/domain/envelope';
import type {
	EnvelopeFieldStore,
	FieldCommandKey,
	FieldPlacementPreparation,
	PublishFieldPlacementCommand
} from '$lib/ports/envelope-field-store';
import { isUuidV7 } from '$lib/ids/uuid-v7';
import { EnvelopeFieldApplication, InvalidFieldPlacementError } from './fields';

const organizationId: string = '01900000-0000-7000-8000-000000000002';
const envelopeId: string = '01900000-0000-7000-8000-000000000001';
const signerId: string = '01900000-0000-7000-8000-000000000003';
const viewerId: string = '01900000-0000-7000-8000-000000000004';
const commitSha: string = '0123456789abcdef0123456789abcdef01234567';

const actor = {
	id: 'user-1',
	organizationId,
	organizationName: 'Workspace'
} as const;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	return createHash('sha256').update(bytes).digest('hex');
}

class FixedEnvelopeStore implements DraftMutationStore {
	constructor(private readonly envelope: Envelope) {}

	async findForOrganization(organizationId: string, envelopeId: string): Promise<Envelope | null> {
		if (this.envelope.organizationId !== organizationId || this.envelope.id !== envelopeId)
			return null;
		return { ...this.envelope };
	}

	async compareAndSetDraftPointer(): Promise<boolean> {
		return false;
	}

	async transition(): Promise<boolean> {
		return false;
	}

	async prepareDraftRevision(): Promise<DraftRevisionPreparation> {
		throw new Error('Unexpected draft preparation');
	}

	async publishDraftRevision(): Promise<PublishDraftRevisionResult> {
		throw new Error('Unexpected draft publication');
	}
}

class FixedDraftRepository implements DraftRepository {
	constructor(private readonly documents: readonly DraftDocument[]) {}

	async read(): Promise<readonly DraftDocument[]> {
		return this.documents;
	}

	async commit(): Promise<DraftVersion> {
		throw new Error('Unexpected repository commit');
	}
}

async function draftPersistenceFor(
	envelope: Envelope,
	documents: readonly DraftDocument[]
): Promise<DraftPersistenceService> {
	const objects = new InMemoryObjectStore();
	if (envelope.repositoryArchiveKey !== null) {
		const archive: Uint8Array = new TextEncoder().encode('archive');
		objects.seed(envelope.repositoryArchiveKey, archive);
	}
	return new DraftPersistenceService(
		new FixedEnvelopeStore(envelope),
		objects,
		new FixedDraftRepository(documents)
	);
}

async function readyEnvelope(overrides: Partial<Envelope> = {}): Promise<Envelope> {
	const archiveSha256: string = await sha256Hex(new TextEncoder().encode('archive'));
	return {
		id: envelopeId,
		organizationId,
		title: 'Agreement',
		status: 'ready',
		repositoryGeneration: 2,
		repositoryHead: commitSha,
		repositoryArchiveKey: draftArchiveKey(organizationId, envelopeId, archiveSha256),
		repositoryArchiveSha256: archiveSha256,
		sentCommitSha: null,
		fieldGeneration: 0,
		createdAt: '2026-09-11T00:00:00.000Z',
		updatedAt: '2026-09-11T00:01:00.000Z',
		...overrides
	};
}

const recipients: readonly Recipient[] = [
	{
		id: signerId,
		organizationId,
		envelopeId,
		email: 'signer@example.com',
		name: 'Signer',
		role: 'signer',
		locale: 'en',
		routingOrder: 1,
		status: 'pending'
	},
	{
		id: viewerId,
		organizationId,
		envelopeId,
		email: 'viewer@example.com',
		name: 'Viewer',
		role: 'viewer',
		locale: 'en',
		routingOrder: 2,
		status: 'pending'
	}
];

class CapturingStore implements EnvelopeFieldStore {
	readonly keys: FieldCommandKey[] = [];
	readonly commands: PublishFieldPlacementCommand[] = [];

	constructor(private readonly envelope: Envelope) {}

	async prepareFieldPlacement(key: FieldCommandKey): Promise<FieldPlacementPreparation> {
		this.keys.push(key);
		return {
			outcome: 'ready',
			envelope: this.envelope,
			recipients,
			auditHead: { sequence: 3, eventHash: 'b'.repeat(64) }
		};
	}

	async publishFieldPlacement(command: PublishFieldPlacementCommand) {
		this.commands.push(command);
		return {
			outcome: 'published' as const,
			result: {
				envelopeId: command.envelopeId,
				generation: command.expectedGeneration,
				fieldGeneration: command.expectedFieldGeneration + 1,
				commitSha: command.expectedCommitSha,
				fields: command.fields.map((field) => ({
					id: field.id,
					recipientId: field.recipientId,
					documentPath: field.documentPath,
					fieldType: field.fieldType,
					required: field.required,
					position: field.position,
					geometry: field.geometry
				})),
				updatedAt: command.updatedAt,
				auditEventId: command.auditEventId
			}
		};
	}
}

describe('EnvelopeFieldApplication', () => {
	it('validates signer recipients and document paths, then publishes a canonical field set', async () => {
		const envelope: Envelope = await readyEnvelope();
		const store: CapturingStore = new CapturingStore(envelope);
		const drafts: DraftPersistenceService = await draftPersistenceFor(envelope, [
			{ path: 'documents/agreement.md', content: '# Agreement' },
			{ path: 'documents/appendix.md', content: '# Appendix' }
		]);
		const application: EnvelopeFieldApplication = new EnvelopeFieldApplication(store, drafts);

		const result = await application.place(actor, envelopeId, {
			idempotencyKey: 'fields-1',
			expectedGeneration: 2,
			expectedFieldGeneration: 0,
			fields: [
				{
					recipientId: signerId,
					documentPath: 'documents/appendix.md',
					fieldType: 'initials',
					label: 'Initial here',
					required: false,
					position: 1,
					// The appendix is the second document, and every document starts
					// on a fresh page in the rendering, so its first page is 2.
					geometry: { page: 2, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
				},
				{
					recipientId: signerId,
					documentPath: 'documents/agreement.md',
					fieldType: 'signature',
					label: 'Sign here',
					required: true,
					position: 1,
					geometry: { page: 1, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
				}
			]
		});

		expect(result.outcome).toBe('published');
		expect(store.commands[0].fields.map((field) => field.documentPath)).toEqual([
			'documents/agreement.md',
			'documents/appendix.md'
		]);
		expect(store.commands[0]).toMatchObject({
			expectedCommitSha: envelope.repositoryHead,
			expectedAuditSequence: 3,
			previousAuditHash: 'b'.repeat(64)
		});
		expect(JSON.parse(store.commands[0].auditPayloadJson)).toEqual({
			commitSha: envelope.repositoryHead,
			generation: envelope.repositoryGeneration,
			fieldGeneration: 1,
			fields: store.commands[0].fields.map((field) => ({
				id: field.id,
				recipientId: field.recipientId,
				documentPath: field.documentPath,
				fieldType: field.fieldType,
				required: field.required,
				position: field.position,
				geometry: field.geometry
			}))
		});
		expect(store.commands[0].auditPayloadJson).not.toContain('Sign here');
		expect(store.commands[0].auditPayloadJson).not.toContain('Initial here');
	});

	it('refuses a field placed on a page outside its own document', async () => {
		const envelope: Envelope = await readyEnvelope();
		const store: CapturingStore = new CapturingStore(envelope);
		const drafts: DraftPersistenceService = await draftPersistenceFor(envelope, [
			{ path: 'documents/agreement.md', content: '# Agreement' },
			{ path: 'documents/appendix.md', content: '# Appendix' }
		]);

		const result = await new EnvelopeFieldApplication(store, drafts).place(actor, envelopeId, {
			idempotencyKey: 'fields-bad-page',
			expectedGeneration: 2,
			expectedFieldGeneration: 0,
			fields: [
				{
					recipientId: signerId,
					documentPath: 'documents/agreement.md',
					fieldType: 'signature',
					label: 'Sign here',
					required: true,
					position: 1,
					geometry: { page: 2, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
				}
			]
		});

		expect(result).toEqual({ outcome: 'invalid_geometry' });
		expect(store.commands).toHaveLength(0);
	});

	it('refuses a box that would extend past the edge of its page', async () => {
		const envelope: Envelope = await readyEnvelope();
		const store: CapturingStore = new CapturingStore(envelope);
		const drafts: DraftPersistenceService = await draftPersistenceFor(envelope, [
			{ path: 'documents/agreement.md', content: '# Agreement' }
		]);

		await expect(
			new EnvelopeFieldApplication(store, drafts).place(actor, envelopeId, {
				idempotencyKey: 'fields-overflow',
				expectedGeneration: 2,
				expectedFieldGeneration: 0,
				fields: [
					{
						recipientId: signerId,
						documentPath: 'documents/agreement.md',
						fieldType: 'signature',
						label: 'Sign here',
						required: true,
						position: 1,
						geometry: { page: 1, x: 0.9, y: 0.1, width: 0.25, height: 0.05 }
					}
				]
			})
		).rejects.toThrow(/inside the page/);
		expect(store.commands).toHaveLength(0);
	});

	it('mints a distinct canonical UUIDv7 per published field set, even for the same locator', async () => {
		const envelope: Envelope = await readyEnvelope();
		const drafts: DraftPersistenceService = await draftPersistenceFor(envelope, [
			{ path: 'documents/agreement.md', content: '# Agreement' }
		]);
		const first: CapturingStore = new CapturingStore(envelope);
		const second: CapturingStore = new CapturingStore(envelope);
		const baseField = {
			recipientId: signerId,
			documentPath: 'documents/agreement.md' as const,
			fieldType: 'signature' as const,
			required: true,
			position: 1,
			geometry: { page: 1, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
		};

		await new EnvelopeFieldApplication(first, drafts).place(actor, envelopeId, {
			idempotencyKey: 'a',
			expectedGeneration: 2,
			expectedFieldGeneration: 0,
			fields: [{ ...baseField, label: 'Sign here' }]
		});
		await new EnvelopeFieldApplication(second, drafts).place(actor, envelopeId, {
			idempotencyKey: 'b',
			expectedGeneration: 2,
			expectedFieldGeneration: 0,
			fields: [{ ...baseField, label: 'Different label' }]
		});

		const firstId: string = first.commands[0].fields[0].id;
		const secondId: string = second.commands[0].fields[0].id;
		expect(isUuidV7(firstId)).toBe(true);
		expect(isUuidV7(secondId)).toBe(true);
		expect(firstId).not.toBe(secondId);
		// Later placements sort after earlier ones, so a field set is still
		// ordered by creation without carrying a stable locator-derived ID.
		expect(secondId > firstId).toBe(true);
	});

	it('rejects a field referencing a non-signer recipient without publishing', async () => {
		const envelope: Envelope = await readyEnvelope();
		const store: CapturingStore = new CapturingStore(envelope);
		const drafts: DraftPersistenceService = await draftPersistenceFor(envelope, [
			{ path: 'documents/agreement.md', content: '# Agreement' }
		]);
		const application: EnvelopeFieldApplication = new EnvelopeFieldApplication(store, drafts);

		const result = await application.place(actor, envelopeId, {
			idempotencyKey: 'fields-1',
			expectedGeneration: 2,
			expectedFieldGeneration: 0,
			fields: [
				{
					recipientId: viewerId,
					documentPath: 'documents/agreement.md',
					fieldType: 'signature',
					label: 'Sign here',
					required: true,
					position: 1,
					geometry: { page: 1, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
				}
			]
		});

		expect(result).toEqual({ outcome: 'invalid_recipient' });
		expect(store.commands).toHaveLength(0);
	});

	it('rejects a field referencing a document outside the current workspace', async () => {
		const envelope: Envelope = await readyEnvelope();
		const store: CapturingStore = new CapturingStore(envelope);
		const drafts: DraftPersistenceService = await draftPersistenceFor(envelope, [
			{ path: 'documents/agreement.md', content: '# Agreement' }
		]);
		const application: EnvelopeFieldApplication = new EnvelopeFieldApplication(store, drafts);

		const result = await application.place(actor, envelopeId, {
			idempotencyKey: 'fields-1',
			expectedGeneration: 2,
			expectedFieldGeneration: 0,
			fields: [
				{
					recipientId: signerId,
					documentPath: 'documents/missing.md',
					fieldType: 'signature',
					label: 'Sign here',
					required: true,
					position: 1,
					geometry: { page: 1, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
				}
			]
		});

		expect(result).toEqual({ outcome: 'invalid_document' });
		expect(store.commands).toHaveLength(0);
	});

	it('returns generation_conflict when the workspace no longer matches the expected generation', async () => {
		const envelope: Envelope = await readyEnvelope({ repositoryGeneration: 5 });
		const store: CapturingStore = new CapturingStore(envelope);
		const drafts: DraftPersistenceService = await draftPersistenceFor(envelope, [
			{ path: 'documents/agreement.md', content: '# Agreement' }
		]);
		const application: EnvelopeFieldApplication = new EnvelopeFieldApplication(store, drafts);

		const result = await application.place(actor, envelopeId, {
			idempotencyKey: 'fields-1',
			expectedGeneration: 2,
			expectedFieldGeneration: 0,
			fields: [
				{
					recipientId: signerId,
					documentPath: 'documents/agreement.md',
					fieldType: 'signature',
					label: 'Sign here',
					required: true,
					position: 1,
					geometry: { page: 1, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
				}
			]
		});

		expect(result).toEqual({ outcome: 'generation_conflict' });
		expect(store.commands).toHaveLength(0);
	});

	it('returns preparation conflicts without attempting publication or reading the workspace', async () => {
		const drafts: DraftPersistenceService = await draftPersistenceFor(await readyEnvelope(), []);
		const store: EnvelopeFieldStore = {
			prepareFieldPlacement: vi.fn(async (): Promise<FieldPlacementPreparation> => ({
				outcome: 'field_generation_conflict'
			})),
			publishFieldPlacement: vi.fn()
		};
		const result = await new EnvelopeFieldApplication(store, drafts).place(actor, envelopeId, {
			idempotencyKey: 'fields-1',
			expectedGeneration: 2,
			expectedFieldGeneration: 3,
			fields: [
				{
					recipientId: signerId,
					documentPath: 'documents/agreement.md',
					fieldType: 'signature',
					label: 'Sign here',
					required: true,
					position: 1,
					geometry: { page: 1, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
				}
			]
		});

		expect(result).toEqual({ outcome: 'field_generation_conflict' });
		expect(store.publishFieldPlacement).not.toHaveBeenCalled();
	});

	it('publishes normalized page/x/y/width/height geometry alongside position', async () => {
		const envelope: Envelope = await readyEnvelope();
		const store: CapturingStore = new CapturingStore(envelope);
		const drafts: DraftPersistenceService = await draftPersistenceFor(envelope, [
			{ path: 'documents/agreement.md', content: '# Agreement' }
		]);
		const application: EnvelopeFieldApplication = new EnvelopeFieldApplication(store, drafts);
		const geometry = { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.05 };

		const result = await application.place(actor, envelopeId, {
			idempotencyKey: 'fields-geometry',
			expectedGeneration: 2,
			expectedFieldGeneration: 0,
			fields: [
				{
					recipientId: signerId,
					documentPath: 'documents/agreement.md',
					fieldType: 'signature',
					label: 'Sign here',
					required: true,
					position: 1,
					geometry
				}
			]
		});

		expect(result.outcome).toBe('published');
		expect(store.commands[0].fields[0].geometry).toEqual(geometry);
		const auditFields = JSON.parse(store.commands[0].auditPayloadJson).fields;
		expect(auditFields[0].geometry).toEqual(geometry);
	});

	it.each([
		{ page: 0, x: 0, y: 0, width: 0.1, height: 0.1 },
		{ page: 1, x: -0.1, y: 0, width: 0.1, height: 0.1 },
		{ page: 1, x: 0, y: 0, width: 0, height: 0.1 },
		{ page: 1, x: 0, y: 0, width: 1.1, height: 0.1 }
	])('rejects out-of-range field geometry %#', async (geometry) => {
		const envelope: Envelope = await readyEnvelope();
		const store: CapturingStore = new CapturingStore(envelope);
		const drafts: DraftPersistenceService = await draftPersistenceFor(envelope, [
			{ path: 'documents/agreement.md', content: '# Agreement' }
		]);
		const application: EnvelopeFieldApplication = new EnvelopeFieldApplication(store, drafts);

		await expect(
			application.place(actor, envelopeId, {
				idempotencyKey: 'fields-geometry-invalid',
				expectedGeneration: 2,
				expectedFieldGeneration: 0,
				fields: [
					{
						recipientId: signerId,
						documentPath: 'documents/agreement.md',
						fieldType: 'signature',
						label: 'Sign here',
						required: true,
						position: 1,
						geometry
					}
				]
			})
		).rejects.toBeInstanceOf(InvalidFieldPlacementError);
	});

	it('rejects repeated recipient/document positions before calling the store', async () => {
		const envelope: Envelope = await readyEnvelope();
		const store: CapturingStore = new CapturingStore(envelope);
		const drafts: DraftPersistenceService = await draftPersistenceFor(envelope, [
			{ path: 'documents/agreement.md', content: '# Agreement' }
		]);
		const application: EnvelopeFieldApplication = new EnvelopeFieldApplication(store, drafts);
		const duplicate = {
			recipientId: signerId,
			documentPath: 'documents/agreement.md' as const,
			fieldType: 'signature' as const,
			label: 'Sign here',
			required: true,
			position: 1,
			geometry: { page: 1, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
		};

		await expect(
			application.place(actor, envelopeId, {
				idempotencyKey: 'fields-1',
				expectedGeneration: 2,
				expectedFieldGeneration: 0,
				fields: [duplicate, { ...duplicate, fieldType: 'initials', label: 'Initial here instead' }]
			})
		).rejects.toBeInstanceOf(InvalidFieldPlacementError);
		expect(store.keys).toHaveLength(0);
	});

	it('rejects a field generation that cannot be incremented portably', async () => {
		const envelope: Envelope = await readyEnvelope();
		const store: CapturingStore = new CapturingStore(envelope);
		const drafts: DraftPersistenceService = await draftPersistenceFor(envelope, [
			{ path: 'documents/agreement.md', content: '# Agreement' }
		]);

		await expect(
			new EnvelopeFieldApplication(store, drafts).place(actor, envelopeId, {
				idempotencyKey: 'fields-max',
				expectedGeneration: 2,
				expectedFieldGeneration: 2_147_483_647,
				fields: [
					{
						recipientId: signerId,
						documentPath: 'documents/agreement.md',
						fieldType: 'signature',
						label: 'Sign here',
						required: true,
						position: 1,
						geometry: { page: 1, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
					}
				]
			})
		).rejects.toBeInstanceOf(InvalidFieldPlacementError);
		expect(store.keys).toHaveLength(0);
	});

	it('makes semantically identical field ordering share a request fingerprint', async () => {
		const envelope: Envelope = await readyEnvelope();
		const drafts: DraftPersistenceService = await draftPersistenceFor(envelope, [
			{ path: 'documents/agreement.md', content: '# Agreement' },
			{ path: 'documents/appendix.md', content: '# Appendix' }
		]);
		const fields = [
			{
				recipientId: signerId,
				documentPath: 'documents/agreement.md' as const,
				fieldType: 'signature' as const,
				label: 'Sign here',
				required: true,
				position: 1,
				geometry: { page: 1, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
			},
			{
				recipientId: signerId,
				documentPath: 'documents/appendix.md' as const,
				fieldType: 'initials' as const,
				label: 'Initial here',
				required: false,
				position: 1,
				geometry: { page: 1, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
			}
		];
		const first: CapturingStore = new CapturingStore(envelope);
		const second: CapturingStore = new CapturingStore(envelope);
		await new EnvelopeFieldApplication(first, drafts).place(actor, envelopeId, {
			idempotencyKey: 'same-key',
			expectedGeneration: 2,
			expectedFieldGeneration: 0,
			fields
		});
		await new EnvelopeFieldApplication(second, drafts).place(actor, envelopeId, {
			idempotencyKey: 'same-key',
			expectedGeneration: 2,
			expectedFieldGeneration: 0,
			fields: [...fields].reverse()
		});

		expect(first.keys[0].requestFingerprint).toBe(second.keys[0].requestFingerprint);
	});
});
