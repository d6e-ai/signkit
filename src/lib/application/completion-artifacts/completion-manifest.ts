import { gzipSync } from 'fflate';
import type { FieldType, RecipientRole, RecipientStatus } from '$lib/domain/envelope';
import { isActionableRecipientRole } from '$lib/domain/envelope';
import {
	CompletionArtifactBoundExceededError,
	CompletionArtifactIntegrityError,
	MAX_COMPLETION_AUDIT_VERIFY_EVENTS,
	type CompletionEvidenceAuditEvent,
	type CompletionEvidenceField,
	type CompletionEvidenceRecipient
} from '$lib/ports/completion-artifact-store';
import {
	verifyCompletionAuditChain,
	type CompletionAuditChainVerification
} from './audit-event-integrity';

export {
	CompletionArtifactBoundExceededError,
	CompletionArtifactIntegrityError
} from '$lib/ports/completion-artifact-store';

export const COMPLETION_MANIFEST_SCHEMA: string = 'signkit-completion-manifest-v1';
export const MAX_AUDIT_VERIFY_EVENTS: number = MAX_COMPLETION_AUDIT_VERIFY_EVENTS;
/** Matches the repository's own `MAX_FILES` contract (src/lib/history/isomorphic-git-repository.ts). */
export const MAX_MANIFEST_DOCUMENT_COUNT: number = 5_000;
export const MAX_MANIFEST_RECIPIENT_COUNT: number = 50;
export const MAX_MANIFEST_FIELD_COUNT: number = 50;
export const MAX_MANIFEST_SOURCE_BYTES: number = 2 * 1024 * 1024;
export const MAX_MANIFEST_GZIP_BYTES: number = 2 * 1024 * 1024;

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN: RegExp = /^[a-f0-9]{40}$/;
const PUBLISHED_EVENT_TYPE: string = 'envelope.completion_artifact_published';
const READY_EVENT_TYPE: string = 'envelope.ready';
const SENT_EVENT_TYPE: string = 'envelope.sent';
const SIGNED_EVENT_TYPE: string = 'recipient.signed';
const APPROVED_EVENT_TYPE: string = 'recipient.approved';

export interface CompletionManifestDocument {
	path?: string;
	sha256: string;
	id?: string;
	kind?: 'markdown' | 'pdf';
	position?: number;
	title?: string;
	byteSize?: number;
	pageCount?: number;
}

export interface CompletionManifestRecipient {
	id: string;
	role: RecipientRole;
	routingOrder: number;
	status: RecipientStatus;
	decisionEventId: string | null;
	decisionAt: string | null;
}

export interface CompletionManifestField {
	id: string;
	fieldType: FieldType;
	valueSha256: string;
}

/** Re-derived by {@link verifyCompletionAuditChain}; see its docstring for exactly what is and is not guaranteed. */
export type CompletionManifestAuditProof = CompletionAuditChainVerification;

export interface CompletionManifestV1 {
	schema: typeof COMPLETION_MANIFEST_SCHEMA;
	envelopeId: string;
	title: string;
	sentCommitSha: string;
	draftArchiveSha256: string;
	fieldGeneration: number;
	completedAt: string;
	documentSetHash?: string;
	documents: readonly CompletionManifestDocument[];
	recipients: readonly CompletionManifestRecipient[];
	fields: readonly CompletionManifestField[];
	auditProof: CompletionManifestAuditProof;
}

export interface BuildCompletionManifestInput {
	organizationId: string;
	envelopeId: string;
	title: string;
	sentCommitSha: string;
	draftArchiveSha256: string;
	fieldGeneration: number;
	documentSetHash?: string;
	documents: readonly CompletionManifestDocument[];
	recipients: readonly CompletionEvidenceRecipient[];
	fields: readonly CompletionEvidenceField[];
	auditEvents: readonly CompletionEvidenceAuditEvent[];
}

interface SignedFieldDeclaration {
	id: string;
	fieldType: string;
	valueSha256: string;
}

/**
 * Build the canonical v1 manifest from pinned Git documents plus SQL
 * evidence. Every collection is deterministically sorted, the audit chain is
 * fully hash-verified, and the field/recipient evidence is cross-checked
 * against that verified chain before any bytes are produced, so a manifest
 * never claims more integrity than what was actually checked.
 */
export async function buildCompletionManifest(
	input: BuildCompletionManifestInput
): Promise<CompletionManifestV1> {
	if (!GIT_SHA_PATTERN.test(input.sentCommitSha)) {
		throw new CompletionArtifactIntegrityError('Completion evidence has an invalid Git commit SHA');
	}
	if (!SHA256_PATTERN.test(input.draftArchiveSha256)) {
		throw new CompletionArtifactIntegrityError(
			'Completion evidence has an invalid archive SHA-256'
		);
	}
	if (input.documents.length === 0) {
		throw new CompletionArtifactIntegrityError('Completion evidence has an invalid document count');
	}
	if (input.documents.length > MAX_MANIFEST_DOCUMENT_COUNT) {
		throw new CompletionArtifactBoundExceededError(
			`Completion evidence exceeds the ${MAX_MANIFEST_DOCUMENT_COUNT}-document bound`
		);
	}
	if (input.recipients.length === 0) {
		throw new CompletionArtifactIntegrityError(
			'Completion evidence has an invalid recipient count'
		);
	}
	if (input.recipients.length > MAX_MANIFEST_RECIPIENT_COUNT) {
		throw new CompletionArtifactBoundExceededError(
			`Completion evidence exceeds the ${MAX_MANIFEST_RECIPIENT_COUNT}-recipient bound`
		);
	}
	if (input.fields.length > MAX_MANIFEST_FIELD_COUNT) {
		throw new CompletionArtifactBoundExceededError(
			`Completion evidence exceeds the ${MAX_MANIFEST_FIELD_COUNT}-field bound`
		);
	}

	const { proof: auditProof, payloadsByEventId } = await verifyCompletionAuditChain(
		input.auditEvents,
		{ organizationId: input.organizationId, envelopeId: input.envelopeId },
		MAX_AUDIT_VERIFY_EVENTS
	);
	verifyFieldsMatchSignedAuditTrail(input.auditEvents, payloadsByEventId, input.fields);
	verifyRecipientRosterMatchesReadyEvent(input.auditEvents, payloadsByEventId, input.recipients);
	verifyRecipientDecisionsMatchAuditTrail(input.auditEvents, input.recipients);

	const attestedDocumentSetHash: string | null = attestedSentDocumentSetHash(
		input.auditEvents,
		payloadsByEventId
	);
	if (input.documentSetHash !== undefined) {
		if (attestedDocumentSetHash !== input.documentSetHash) {
			throw new CompletionArtifactIntegrityError(
				'Completion document set hash does not match the verified envelope.sent payload'
			);
		}
	} else if (attestedDocumentSetHash !== null) {
		throw new CompletionArtifactIntegrityError(
			'Verified envelope.sent payload attests a document set hash the pinned revision does not bind'
		);
	}

	if (input.documentSetHash !== undefined && !SHA256_PATTERN.test(input.documentSetHash)) {
		throw new CompletionArtifactIntegrityError('Completion document set hash is invalid');
	}

	const documents: CompletionManifestDocument[] = input.documents
		.map((document: CompletionManifestDocument): CompletionManifestDocument => {
			if (!SHA256_PATTERN.test(document.sha256)) {
				throw new CompletionArtifactIntegrityError('Completion document has an invalid SHA-256');
			}
			return canonicalCompletionDocument(document);
		})
		.sort((left, right): number => compareCompletionDocuments(left, right));
	const recipients: CompletionManifestRecipient[] = input.recipients
		.map((recipient: CompletionEvidenceRecipient): CompletionManifestRecipient => ({
			id: recipient.id,
			role: recipient.role,
			routingOrder: recipient.routingOrder,
			status: recipient.status,
			decisionEventId: recipient.decisionEventId,
			decisionAt: recipient.decisionOccurredAt
		}))
		.sort((left, right): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	const fields: CompletionManifestField[] = input.fields
		.map((field: CompletionEvidenceField): CompletionManifestField => ({
			id: field.id,
			fieldType: field.fieldType,
			valueSha256: field.valueSha256
		}))
		.sort((left, right): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

	const anchor: CompletionEvidenceAuditEvent = input.auditEvents[input.auditEvents.length - 1];
	return {
		schema: COMPLETION_MANIFEST_SCHEMA,
		envelopeId: input.envelopeId,
		title: input.title,
		sentCommitSha: input.sentCommitSha,
		draftArchiveSha256: input.draftArchiveSha256,
		fieldGeneration: input.fieldGeneration,
		completedAt: anchor.occurredAt,
		...(input.documentSetHash === undefined ? {} : { documentSetHash: input.documentSetHash }),
		documents,
		recipients,
		fields,
		auditProof
	};
}

function canonicalCompletionDocument(
	document: CompletionManifestDocument
): CompletionManifestDocument {
	const canonical: CompletionManifestDocument =
		document.path === undefined
			? { sha256: document.sha256 }
			: { path: document.path, sha256: document.sha256 };
	if (document.id !== undefined) canonical.id = document.id;
	if (document.kind !== undefined) canonical.kind = document.kind;
	if (document.position !== undefined) canonical.position = document.position;
	if (document.title !== undefined) canonical.title = document.title;
	if (document.byteSize !== undefined) canonical.byteSize = document.byteSize;
	if (document.pageCount !== undefined) canonical.pageCount = document.pageCount;
	return canonical;
}

function compareCompletionDocuments(
	left: CompletionManifestDocument,
	right: CompletionManifestDocument
): number {
	if (left.position !== undefined && right.position !== undefined) {
		return left.position - right.position;
	}
	const leftPath: string = left.path ?? '';
	const rightPath: string = right.path ?? '';
	return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}

function attestedSentDocumentSetHash(
	auditEvents: readonly CompletionEvidenceAuditEvent[],
	payloadsByEventId: ReadonlyMap<string, unknown>
): string | null {
	const sentEvents: CompletionEvidenceAuditEvent[] = auditEvents.filter(
		(event: CompletionEvidenceAuditEvent): boolean => event.eventType === SENT_EVENT_TYPE
	);
	if (sentEvents.length === 0) return null;
	if (sentEvents.length !== 1) {
		throw new CompletionArtifactIntegrityError(
			'Completion evidence has more than one envelope.sent event'
		);
	}
	const payload: unknown = payloadsByEventId.get(sentEvents[0].id);
	if (typeof payload !== 'object' || payload === null) {
		throw new CompletionArtifactIntegrityError('Verified envelope.sent payload is missing');
	}
	const hash: unknown = (payload as Record<string, unknown>).documentSetHash;
	if (hash === undefined) return null;
	if (typeof hash !== 'string' || !SHA256_PATTERN.test(hash)) {
		throw new CompletionArtifactIntegrityError('Verified envelope.sent documentSetHash is invalid');
	}
	return hash;
}

/**
 * The `field_value` table is not itself part of the hashed audit chain, so a
 * row inserted, deleted, or substituted after signing would otherwise slip
 * past chain verification undetected. This requires the complete field set to
 * equal — exactly, not just a superset or subset — the union of `payload.fields`
 * declared across every verified `recipient.signed` event.
 */
function verifyFieldsMatchSignedAuditTrail(
	auditEvents: readonly CompletionEvidenceAuditEvent[],
	payloadsByEventId: ReadonlyMap<string, unknown>,
	fields: readonly CompletionEvidenceField[]
): void {
	const declaredById = new Map<string, SignedFieldDeclaration>();
	for (const event of auditEvents) {
		if (event.eventType !== SIGNED_EVENT_TYPE) continue;
		const payload: unknown = payloadsByEventId.get(event.id);
		for (const declared of extractSignedFieldDeclarations(payload)) {
			if (declaredById.has(declared.id)) {
				throw new CompletionArtifactIntegrityError(
					'Completion audit trail declares the same field more than once'
				);
			}
			declaredById.set(declared.id, declared);
		}
	}
	if (declaredById.size !== fields.length) {
		throw new CompletionArtifactIntegrityError(
			'Field evidence does not match the signed audit trail'
		);
	}
	for (const field of fields) {
		const declared: SignedFieldDeclaration | undefined = declaredById.get(field.id);
		if (
			declared === undefined ||
			declared.fieldType !== field.fieldType ||
			declared.valueSha256 !== field.valueSha256
		) {
			throw new CompletionArtifactIntegrityError(
				'Field evidence does not match the signed audit trail'
			);
		}
	}
}

function extractSignedFieldDeclarations(payload: unknown): readonly SignedFieldDeclaration[] {
	if (
		typeof payload !== 'object' ||
		payload === null ||
		!Array.isArray((payload as Record<string, unknown>).fields)
	) {
		throw new CompletionArtifactIntegrityError(
			'Signed audit event payload is missing its field declarations'
		);
	}
	const declared: SignedFieldDeclaration[] = [];
	for (const candidate of (payload as { fields: readonly unknown[] }).fields) {
		if (
			typeof candidate !== 'object' ||
			candidate === null ||
			typeof (candidate as Record<string, unknown>).id !== 'string' ||
			typeof (candidate as Record<string, unknown>).fieldType !== 'string' ||
			typeof (candidate as Record<string, unknown>).valueSha256 !== 'string' ||
			!SHA256_PATTERN.test((candidate as Record<string, unknown>).valueSha256 as string)
		) {
			throw new CompletionArtifactIntegrityError(
				'Signed audit event payload has a malformed field declaration'
			);
		}
		declared.push(candidate as SignedFieldDeclaration);
	}
	return declared;
}

interface ReadyRecipientDeclaration {
	id: string;
	role: string;
	routingOrder: number;
}

/**
 * The `recipient` table is not itself part of the hashed audit chain, so a
 * row inserted, deleted, or given a substituted role/routing order would
 * otherwise slip past chain verification undetected. This requires the
 * complete recipient set to equal — exactly — the `payload.recipients`
 * declared by the envelope's one `envelope.ready` event, which is the only
 * point in the workflow that ever declares the recipient graph.
 */
function verifyRecipientRosterMatchesReadyEvent(
	auditEvents: readonly CompletionEvidenceAuditEvent[],
	payloadsByEventId: ReadonlyMap<string, unknown>,
	recipients: readonly CompletionEvidenceRecipient[]
): void {
	const readyEvents: readonly CompletionEvidenceAuditEvent[] = auditEvents.filter(
		(event: CompletionEvidenceAuditEvent): boolean => event.eventType === READY_EVENT_TYPE
	);
	if (readyEvents.length !== 1) {
		throw new CompletionArtifactIntegrityError(
			'Completion audit trail must contain exactly one envelope.ready event'
		);
	}
	const declared: readonly ReadyRecipientDeclaration[] = extractReadyRecipientDeclarations(
		payloadsByEventId.get(readyEvents[0].id)
	);
	const declaredById = new Map<string, ReadyRecipientDeclaration>();
	for (const entry of declared) {
		if (declaredById.has(entry.id)) {
			throw new CompletionArtifactIntegrityError(
				'envelope.ready audit trail declares the same recipient more than once'
			);
		}
		declaredById.set(entry.id, entry);
	}
	if (declaredById.size !== recipients.length) {
		throw new CompletionArtifactIntegrityError(
			'Recipient evidence does not match the envelope.ready audit trail'
		);
	}
	for (const recipient of recipients) {
		const entry: ReadyRecipientDeclaration | undefined = declaredById.get(recipient.id);
		if (
			entry === undefined ||
			entry.role !== recipient.role ||
			entry.routingOrder !== recipient.routingOrder
		) {
			throw new CompletionArtifactIntegrityError(
				'Recipient evidence does not match the envelope.ready audit trail'
			);
		}
	}
}

function extractReadyRecipientDeclarations(payload: unknown): readonly ReadyRecipientDeclaration[] {
	if (
		typeof payload !== 'object' ||
		payload === null ||
		!Array.isArray((payload as Record<string, unknown>).recipients)
	) {
		throw new CompletionArtifactIntegrityError(
			'envelope.ready audit event payload is missing its recipient declarations'
		);
	}
	const declared: ReadyRecipientDeclaration[] = [];
	for (const candidate of (payload as { recipients: readonly unknown[] }).recipients) {
		if (
			typeof candidate !== 'object' ||
			candidate === null ||
			typeof (candidate as Record<string, unknown>).id !== 'string' ||
			typeof (candidate as Record<string, unknown>).role !== 'string' ||
			typeof (candidate as Record<string, unknown>).routingOrder !== 'number'
		) {
			throw new CompletionArtifactIntegrityError(
				'envelope.ready audit event payload has a malformed recipient declaration'
			);
		}
		declared.push(candidate as ReadyRecipientDeclaration);
	}
	return declared;
}

/**
 * `recipient.decisionEventId`/`decisionOccurredAt` come from a SQL lookup
 * that is not itself part of the hashed chain. Rather than trust that lookup,
 * this requires it to point at an event that the chain verification actually
 * verified, with a matching actor and timestamp, of the type appropriate to
 * that recipient's own role: a signer's decision must be `recipient.signed`,
 * an approver's must be `recipient.approved` — one cannot stand in for the
 * other. Because this manifest is only ever built for an envelope that has
 * reached `completed`, every actionable (signer/approver) recipient is
 * required by that same completion invariant to already have `status:
 * 'completed'` and a matching decision; CC/observer/prefill recipients are
 * never actionable and must have no decision at all.
 */
function verifyRecipientDecisionsMatchAuditTrail(
	auditEvents: readonly CompletionEvidenceAuditEvent[],
	recipients: readonly CompletionEvidenceRecipient[]
): void {
	const eventsById = new Map<string, CompletionEvidenceAuditEvent>(
		auditEvents.map((event: CompletionEvidenceAuditEvent) => [event.id, event] as const)
	);
	for (const recipient of recipients) {
		if (!isActionableRecipientRole(recipient.role)) {
			if (recipient.decisionEventId !== null || recipient.decisionOccurredAt !== null) {
				throw new CompletionArtifactIntegrityError(
					'Non-actionable recipient has a signed or approved decision'
				);
			}
			continue;
		}
		const expectedEventType: string =
			recipient.role === 'signer' ? SIGNED_EVENT_TYPE : APPROVED_EVENT_TYPE;
		if (
			recipient.status !== 'completed' ||
			recipient.decisionEventId === null ||
			recipient.decisionOccurredAt === null
		) {
			throw new CompletionArtifactIntegrityError(
				'Actionable recipient in a completed envelope is missing a completed decision'
			);
		}
		const event: CompletionEvidenceAuditEvent | undefined = eventsById.get(
			recipient.decisionEventId
		);
		if (
			event === undefined ||
			event.eventType !== expectedEventType ||
			event.actorId !== recipient.id ||
			event.occurredAt !== recipient.decisionOccurredAt
		) {
			throw new CompletionArtifactIntegrityError(
				'Recipient decision does not match the verified audit trail'
			);
		}
	}
}

/** Deterministic fixed-key JSON: identical evidence always serializes identically. */
export function canonicalManifestJson(manifest: CompletionManifestV1): string {
	const json: string = JSON.stringify(manifest);
	assertBoundedSourceBytes(json, 'Completion manifest JSON');
	return json;
}

export function renderCompletionMarkdown(manifest: CompletionManifestV1): string {
	const lines: string[] = [
		`# Completion evidence — ${manifest.envelopeId}`,
		'',
		`- Title: ${escapeMarkdownCell(manifest.title)}`,
		`- Sent commit: ${manifest.sentCommitSha}`,
		`- Draft archive SHA-256: ${manifest.draftArchiveSha256}`,
		`- Field generation: ${manifest.fieldGeneration}`,
		`- Completed at: ${manifest.completedAt}`,
		...(manifest.documentSetHash === undefined
			? []
			: [`- Document set hash: ${manifest.documentSetHash}`]),
		'',
		'## Documents',
		'',
		...(manifest.documents.some((document) => document.kind !== undefined)
			? [
					'| ID | Kind | Position | Title | Path | SHA-256 | Pages | Bytes |',
					'| --- | --- | --- | --- | --- | --- | --- | --- |'
				]
			: ['| Path | SHA-256 |', '| --- | --- |'])
	];
	for (const document of manifest.documents) {
		if (document.kind !== undefined) {
			lines.push(
				`| ${escapeMarkdownCell(document.id ?? '')} | ${escapeMarkdownCell(document.kind)} | ${document.position ?? ''} | ${escapeMarkdownCell(document.title ?? '')} | ${escapeMarkdownCell(document.path ?? '')} | ${escapeMarkdownCell(document.sha256)} | ${document.pageCount ?? ''} | ${document.byteSize ?? ''} |`
			);
			continue;
		}
		lines.push(
			`| ${escapeMarkdownCell(document.path ?? '')} | ${escapeMarkdownCell(document.sha256)} |`
		);
	}
	lines.push(
		'',
		'## Recipients',
		'',
		'| ID | Role | Routing order | Status | Decision event | Decision at |',
		'| --- | --- | --- | --- | --- | --- |'
	);
	for (const recipient of manifest.recipients) {
		const decisionEventId: string =
			recipient.decisionEventId === null ? '-' : escapeMarkdownCell(recipient.decisionEventId);
		const decisionAt: string =
			recipient.decisionAt === null ? '-' : escapeMarkdownCell(recipient.decisionAt);
		lines.push(
			`| ${escapeMarkdownCell(recipient.id)} | ${escapeMarkdownCell(recipient.role)} | ${recipient.routingOrder} | ${escapeMarkdownCell(recipient.status)} | ${decisionEventId} | ${decisionAt} |`
		);
	}
	lines.push('', '## Fields', '', '| ID | Type | Value SHA-256 |', '| --- | --- | --- |');
	for (const field of manifest.fields) {
		lines.push(
			`| ${escapeMarkdownCell(field.id)} | ${escapeMarkdownCell(field.fieldType)} | ${escapeMarkdownCell(field.valueSha256)} |`
		);
	}
	lines.push(
		'',
		'## Audit proof',
		'',
		`- Anchor event type: ${escapeMarkdownCell(manifest.auditProof.anchorEventType)}`,
		`- Anchor event ID: ${escapeMarkdownCell(manifest.auditProof.anchorEventId)}`,
		`- Head sequence: ${manifest.auditProof.headSequence}`,
		`- Verified event count: ${manifest.auditProof.verifiedEventCount}`,
		'- Hash chain: every stored event hash was independently re-derived from its recorded fields, and the chain was verified end-to-end through the envelope.completed anchor. This is not a tamper-proof guarantee — a whole-chain database rewrite that recomputes every hash consistently would pass this check. Detecting that requires an external signed/published anchor, which is out of scope for this artifact.',
		''
	);
	const markdown: string = lines.join('\n');
	assertBoundedSourceBytes(markdown, 'Completion manifest Markdown');
	return markdown;
}

/** Deterministic gzip matching the existing draft-archive fflate convention: level 9, mtime 0. */
export function gzipCompletionArtifact(source: string): Uint8Array {
	const encoded: Uint8Array = new TextEncoder().encode(source);
	assertBoundedBytes(encoded, MAX_MANIFEST_SOURCE_BYTES, 'Completion artifact source');
	const gzipped: Uint8Array = gzipSync(encoded, { level: 9, mtime: 0 });
	assertBoundedBytes(gzipped, MAX_MANIFEST_GZIP_BYTES, 'Completion artifact gzip output');
	return gzipped;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

export async function sha256TextHex(value: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(value));
}

function assertBoundedSourceBytes(value: string, label: string): void {
	assertBoundedBytes(new TextEncoder().encode(value), MAX_MANIFEST_SOURCE_BYTES, label);
}

function assertBoundedBytes(bytes: Uint8Array, maximumBytes: number, label: string): void {
	if (bytes.byteLength > maximumBytes) {
		throw new CompletionArtifactBoundExceededError(`${label} exceeds the size limit`);
	}
}

function escapeMarkdownCell(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export const COMPLETION_ARTIFACT_PUBLISHED_EVENT_TYPE: string = PUBLISHED_EVENT_TYPE;
