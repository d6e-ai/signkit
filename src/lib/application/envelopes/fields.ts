import { hashAuditEventV2 } from '$lib/domain/audit';
import {
	fieldTypes,
	type EnvelopeField,
	type FieldGeometry,
	type FieldType
} from '$lib/domain/envelope';
import type {
	DraftPersistenceService,
	DraftWorkspaceSnapshot
} from '$lib/application/drafts/draft-persistence';
import { isUuidV7, newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import type {
	EnvelopeFieldStore,
	FieldPlacementPreparation,
	PublishFieldPlacementCommand,
	PublishFieldPlacementResult,
	PublishedFieldPlacement
} from '$lib/ports/envelope-field-store';
import type { Envelope, Recipient } from '$lib/domain/envelope';
import {
	renderRevisionPdf,
	SentDocumentPdfError
} from '$lib/application/documents/sent-document-pdf';
import type { AgreementPdfResult } from '$lib/adapters/pdf/agreement-pdf';
import type { EnvelopeRequestActor } from './model';
import { envelopeActorType } from './model';

const MAX_GENERATION: number = 2_147_483_647;
const MAX_FIELD_COUNT: number = 50;
const MAX_POSITION: number = 100_000;
const MAX_LABEL_LENGTH: number = 200;

export interface FieldPlacementInput {
	recipientId: string;
	documentPath: `documents/${string}.md`;
	fieldType: FieldType;
	label: string;
	required: boolean;
	position: number;
	/**
	 * Where the box sits on the sent PDF. Required: a field a signer cannot
	 * see is a field they cannot complete, and ordinal-only placement gives
	 * the recipient surface nothing to draw.
	 */
	geometry: FieldGeometry;
}

export interface PlaceFieldsInput {
	idempotencyKey: string;
	expectedGeneration: number;
	expectedFieldGeneration: number;
	fields: readonly FieldPlacementInput[];
}

export type PlaceFieldsResult =
	| { outcome: 'published' | 'replayed'; result: PublishedFieldPlacement }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'not_ready' }
	| { outcome: 'generation_conflict' }
	| { outcome: 'field_generation_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'invalid_document' }
	| { outcome: 'invalid_recipient' }
	| { outcome: 'invalid_geometry' }
	| { outcome: 'integrity_error' };

export interface EnvelopeFieldApplicationPort {
	place(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: PlaceFieldsInput
	): Promise<PlaceFieldsResult>;
}

export class InvalidFieldPlacementError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidFieldPlacementError';
	}
}

export class EnvelopeFieldApplication implements EnvelopeFieldApplicationPort {
	readonly #store: EnvelopeFieldStore;
	readonly #drafts: DraftPersistenceService;
	readonly #newId: UuidV7Generator;

	constructor(
		store: EnvelopeFieldStore,
		drafts: DraftPersistenceService,
		newId: UuidV7Generator = newUuidV7
	) {
		this.#store = store;
		this.#drafts = drafts;
		this.#newId = newId;
	}

	async place(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: PlaceFieldsInput
	): Promise<PlaceFieldsResult> {
		const canonicalFields: readonly FieldPlacementInput[] = canonicalizeFields(input.fields);
		assertFieldsInput(input.expectedGeneration, input.expectedFieldGeneration, canonicalFields);

		const canonicalRequest: string = JSON.stringify({
			expectedGeneration: input.expectedGeneration,
			expectedFieldGeneration: input.expectedFieldGeneration,
			fields: canonicalFields
		});
		const requestFingerprint: string = await sha256(canonicalRequest);
		const actorType: 'user' | 'agent' = envelopeActorType(actor);
		const key = {
			organizationId: actor.organizationId,
			envelopeId,
			actorType,
			actorId: actor.id,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint
		};

		const preparation: FieldPlacementPreparation = await this.#store.prepareFieldPlacement(
			key,
			input.expectedGeneration,
			input.expectedFieldGeneration
		);
		if (preparation.outcome !== 'ready') return preparation;

		const signerIds: Set<string> = new Set(
			preparation.recipients
				.filter((recipient: Recipient): boolean => recipient.role === 'signer')
				.map((recipient: Recipient): string => recipient.id)
		);
		for (const field of canonicalFields) {
			if (!signerIds.has(field.recipientId)) return { outcome: 'invalid_recipient' };
		}

		const workspace: DraftWorkspaceSnapshot = await this.#drafts.readWorkspace({
			organizationId: actor.organizationId,
			envelopeId
		});
		if (
			workspace.generation !== input.expectedGeneration ||
			workspace.commitSha !== preparation.envelope.repositoryHead
		) {
			return { outcome: 'generation_conflict' };
		}
		const documentPaths: Set<string> = new Set(
			workspace.documents.map((document): string => document.path)
		);
		for (const field of canonicalFields) {
			if (!documentPaths.has(field.documentPath)) return { outcome: 'invalid_document' };
		}

		// Geometry names a page of the rendered agreement, so it can only be
		// validated against that rendering. The renderer is deterministic and
		// reads the same pinned revision send will read, so the page map proved
		// here is the page map the recipient will be shown.
		let rendered: AgreementPdfResult;
		try {
			rendered = renderRevisionPdf(workspace.documents);
		} catch (error: unknown) {
			if (error instanceof SentDocumentPdfError) return { outcome: 'invalid_document' };
			throw error;
		}
		const pagesByPath: Map<string, { firstPage: number; lastPage: number }> = new Map(
			rendered.documents.map((entry) => [
				workspace.documents[entry.index].path,
				{ firstPage: entry.firstPage, lastPage: entry.lastPage }
			])
		);
		for (const field of canonicalFields) {
			const range = pagesByPath.get(field.documentPath);
			if (range === undefined) return { outcome: 'invalid_document' };
			if (field.geometry.page < range.firstPage || field.geometry.page > range.lastPage) {
				return { outcome: 'invalid_geometry' };
			}
		}

		// Each published field set mints its own identifiers. Placement is a
		// whole-set replace guarded by `expectedFieldGeneration`, so a client that
		// republishes must re-read the set rather than assume stable IDs; a lost
		// race replays the durable receipt's own field IDs.
		const fields: readonly EnvelopeField[] = canonicalFields.map(
			(field: FieldPlacementInput): EnvelopeField => ({
				id: this.#newId(),
				organizationId: actor.organizationId,
				envelopeId,
				recipientId: field.recipientId,
				documentPath: field.documentPath,
				fieldType: field.fieldType,
				label: field.label,
				required: field.required,
				position: field.position,
				geometry: field.geometry
			})
		);

		const updatedAt: string = new Date().toISOString();
		const auditEventId: string = this.#newId();
		const auditPayloadJson: string = JSON.stringify({
			commitSha: preparation.envelope.repositoryHead,
			generation: preparation.envelope.repositoryGeneration,
			fieldGeneration: input.expectedFieldGeneration + 1,
			fields: fields.map((field: EnvelopeField) => ({
				id: field.id,
				recipientId: field.recipientId,
				documentPath: field.documentPath,
				fieldType: field.fieldType,
				required: field.required,
				position: field.position,
				geometry: field.geometry
			}))
		});
		const auditEventHash: string = await hashAuditEventV2(
			{
				sequence: preparation.auditHead.sequence + 1,
				eventType: 'envelope.fields_placed',
				actorType,
				actorId: actor.id,
				occurredAt: updatedAt,
				payload: JSON.parse(auditPayloadJson) as unknown,
				previousHash: preparation.auditHead.eventHash
			},
			{ organizationId: actor.organizationId, envelopeId }
		);
		const command: PublishFieldPlacementCommand = {
			...key,
			expectedGeneration: input.expectedGeneration,
			expectedFieldGeneration: input.expectedFieldGeneration,
			expectedCommitSha: requiredHead(preparation.envelope),
			fields,
			updatedAt,
			expectedAuditSequence: preparation.auditHead.sequence,
			previousAuditHash: preparation.auditHead.eventHash,
			auditEventId,
			auditEventHash,
			auditPayloadJson
		};
		const published: PublishFieldPlacementResult = await this.#store.publishFieldPlacement(command);
		return published;
	}
}

function assertFieldsInput(
	expectedGeneration: number,
	expectedFieldGeneration: number,
	fields: readonly FieldPlacementInput[]
): void {
	if (
		!Number.isSafeInteger(expectedGeneration) ||
		expectedGeneration < 1 ||
		expectedGeneration > MAX_GENERATION
	) {
		throw new InvalidFieldPlacementError('Expected generation is outside the supported range');
	}
	if (
		!Number.isSafeInteger(expectedFieldGeneration) ||
		expectedFieldGeneration < 0 ||
		expectedFieldGeneration >= MAX_GENERATION
	) {
		throw new InvalidFieldPlacementError(
			'Expected field generation is outside the supported range'
		);
	}
	if (fields.length < 1 || fields.length > MAX_FIELD_COUNT) {
		throw new InvalidFieldPlacementError(
			`Field placement requires between 1 and ${MAX_FIELD_COUNT} fields`
		);
	}
	const locators: Set<string> = new Set<string>();
	for (const field of fields) {
		if (!isUuidV7(field.recipientId)) {
			throw new InvalidFieldPlacementError('Field recipient ID is invalid');
		}
		if (!/^documents\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(field.documentPath)) {
			throw new InvalidFieldPlacementError('Field document path is invalid');
		}
		if (!fieldTypes.includes(field.fieldType)) {
			throw new InvalidFieldPlacementError('Field type is invalid');
		}
		if (
			field.label.length < 1 ||
			field.label.length > MAX_LABEL_LENGTH ||
			hasControlCharacter(field.label)
		) {
			throw new InvalidFieldPlacementError('Field label is invalid');
		}
		if (typeof field.required !== 'boolean') {
			throw new InvalidFieldPlacementError('Field required flag is invalid');
		}
		if (
			!Number.isSafeInteger(field.position) ||
			field.position < 0 ||
			field.position > MAX_POSITION
		) {
			throw new InvalidFieldPlacementError('Field position is invalid');
		}
		assertGeometry(field.geometry);
		const locator: string = [field.recipientId, field.documentPath, field.position].join('\x00');
		if (locators.has(locator)) {
			throw new InvalidFieldPlacementError('Field declarations must not repeat the same locator');
		}
		locators.add(locator);
	}
}

function assertGeometry(geometry: FieldGeometry): void {
	if (geometry === null || typeof geometry !== 'object') {
		throw new InvalidFieldPlacementError('Field geometry is required');
	}
	const { page, x, y, width, height } = geometry;
	if (!Number.isSafeInteger(page) || page < 1 || page > MAX_POSITION) {
		throw new InvalidFieldPlacementError('Field geometry page is invalid');
	}
	for (const value of [x, y]) {
		if (!Number.isFinite(value) || value < 0 || value > 1) {
			throw new InvalidFieldPlacementError('Field geometry coordinates must be between 0 and 1');
		}
	}
	for (const value of [width, height]) {
		if (!Number.isFinite(value) || value <= 0 || value > 1) {
			throw new InvalidFieldPlacementError('Field geometry dimensions must be between 0 and 1');
		}
	}
	// Rounding at the pixel-to-fraction boundary can produce a box that ends a
	// hair past the page edge; anything beyond that tolerance is a box that
	// would be clipped, which is the same as a box a signer cannot fill in.
	if (x + width > 1.0001 || y + height > 1.0001) {
		throw new InvalidFieldPlacementError('Field geometry must stay inside the page');
	}
}

function canonicalizeFields(
	fields: readonly FieldPlacementInput[]
): readonly FieldPlacementInput[] {
	return fields
		.map((field: FieldPlacementInput): FieldPlacementInput => ({
			recipientId: field.recipientId.trim().toLowerCase(),
			documentPath: field.documentPath,
			fieldType: field.fieldType,
			label: field.label.trim(),
			required: field.required,
			position: field.position,
			geometry: field.geometry
		}))
		.sort(
			(left: FieldPlacementInput, right: FieldPlacementInput): number =>
				compareCodeUnits(left.documentPath, right.documentPath) ||
				left.position - right.position ||
				compareCodeUnits(left.recipientId, right.recipientId) ||
				compareCodeUnits(left.fieldType, right.fieldType)
		);
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function requiredHead(envelope: Envelope): string {
	if (envelope.repositoryHead === null) {
		throw new Error('Field placement preparation returned an empty repository head');
	}
	return envelope.repositoryHead;
}

function hasControlCharacter(value: string): boolean {
	for (let index: number = 0; index < value.length; index += 1) {
		const code: number = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

async function sha256(value: string): Promise<string> {
	const bytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(value);
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
