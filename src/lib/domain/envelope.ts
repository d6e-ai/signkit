export const envelopeStatuses = [
	'draft',
	'ready',
	'sent',
	'in_progress',
	'completed',
	'declined',
	'expired',
	'voided'
] as const;

export type EnvelopeStatus = (typeof envelopeStatuses)[number];
export const recipientRoles = ['signer', 'approver', 'viewer', 'prefill', 'cc'] as const;
export const actionableRecipientRoles = ['signer', 'approver'] as const;
export const postSendInvitationRecipientRoles = ['signer', 'approver', 'viewer'] as const;
export type RecipientRole = (typeof recipientRoles)[number];
export type ActionableRecipientRole = (typeof actionableRecipientRoles)[number];
export type PostSendInvitationRecipientRole = (typeof postSendInvitationRecipientRoles)[number];
export type RecipientStatus = 'pending' | 'viewed' | 'completed' | 'declined';
export const fieldTypes = ['signature', 'initials', 'text', 'date', 'checkbox'] as const;
export type FieldType = (typeof fieldTypes)[number];

export interface Envelope {
	id: string;
	organizationId: string;
	title: string;
	status: EnvelopeStatus;
	repositoryGeneration: number;
	repositoryHead: string | null;
	repositoryArchiveKey: string | null;
	repositoryArchiveSha256: string | null;
	sentCommitSha: string | null;
	fieldGeneration: number;
	createdAt: string;
	updatedAt: string;
}

export interface EnvelopeDocument {
	id: string;
	organizationId: string;
	envelopeId: string;
	markdownPath: `documents/${string}.md`;
	title: string;
	position: number;
}

export interface Recipient {
	id: string;
	organizationId: string;
	envelopeId: string;
	email: string;
	name: string;
	role: RecipientRole;
	locale: 'en' | 'ja';
	routingOrder: number;
	status: RecipientStatus;
}

/**
 * Normalized visual placement for a signing field, expressed as unit-square
 * fractions (0..1) of one rendered page. Resolution- and zoom-independent by
 * construction, so it never encodes device pixels or a specific viewer's
 * layout. `page` is 1-indexed. Geometry is optional and additive: a field
 * with `geometry: null` keeps its pre-existing document-order-only meaning.
 */
export interface FieldGeometry {
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * A signing-field placement. Fields are declared only in SQL. `position`
 * describes semantic document order and remains authoritative for reading
 * order; `geometry`, when present, additionally places the field visually.
 */
export interface EnvelopeField {
	id: string;
	organizationId: string;
	envelopeId: string;
	recipientId: string;
	documentId: string | null;
	documentPath: MarkdownPath | null;
	fieldType: FieldType;
	label: string;
	required: boolean;
	position: number;
	geometry: FieldGeometry | null;
}

const allowedTransitions: Readonly<Record<EnvelopeStatus, readonly EnvelopeStatus[]>> = {
	draft: ['ready', 'voided'],
	ready: ['draft', 'sent', 'voided'],
	sent: ['in_progress', 'completed', 'declined', 'expired', 'voided'],
	in_progress: ['completed', 'declined', 'expired', 'voided'],
	completed: [],
	declined: [],
	expired: [],
	voided: []
};

export function canTransitionEnvelope(from: EnvelopeStatus, to: EnvelopeStatus): boolean {
	return allowedTransitions[from].includes(to);
}

export function assertEnvelopeMutable(status: EnvelopeStatus): void {
	if (status !== 'draft') throw new Error(`Envelope is immutable in ${status} state`);
}

export function isActionableRecipientRole(role: RecipientRole): role is ActionableRecipientRole {
	return role === 'signer' || role === 'approver';
}

export function isPostSendInvitationRecipientRole(
	role: RecipientRole
): role is PostSendInvitationRecipientRole {
	return isActionableRecipientRole(role) || role === 'viewer';
}

export type MarkdownPath = `documents/${string}.md`;
export type DraftPath = MarkdownPath;

const MARKDOWN_PATH_PATTERN: RegExp = /^documents\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/;

export function isMarkdownPath(path: string): path is MarkdownPath {
	return MARKDOWN_PATH_PATTERN.test(path) && !path.includes('..');
}

export function isDraftPath(path: string): path is DraftPath {
	return isMarkdownPath(path);
}

export function assertMarkdownPath(path: string): asserts path is MarkdownPath {
	if (!isMarkdownPath(path)) {
		throw new Error('Draft repositories accept Markdown files under documents/ only');
	}
}

export function assertDraftPath(path: string): asserts path is DraftPath {
	assertMarkdownPath(path);
}
