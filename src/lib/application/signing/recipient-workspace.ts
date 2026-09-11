import type { ImmutableDraftRevision } from '$lib/application/drafts/draft-persistence';
import type { DraftDocument } from '$lib/ports/draft-repository';
import type {
	RecipientFieldDeclaration,
	RecipientOwnFields
} from '$lib/ports/recipient-field-declaration-store';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import {
	toPublicRecipientAccess,
	type PublicRecipientAccessContext,
	type RecipientAccessApplicationPort
} from './recipient-access';

export interface RecipientWorkspace {
	access: PublicRecipientAccessContext;
	documents: readonly DraftDocument[];
	fields: readonly RecipientFieldDeclaration[];
	fieldGeneration: number;
}

export interface RecipientWorkspaceApplicationPort {
	resolve(token: string, at: string): Promise<RecipientWorkspace | null>;
}

export type RecipientRevisionReader = (
	revision: ImmutableDraftRevision
) => Promise<readonly DraftDocument[]>;

export type RecipientFieldReader = (context: {
	organizationId: string;
	envelopeId: string;
	recipientId: string;
}) => Promise<RecipientOwnFields | null>;

export class RecipientWorkspaceIntegrityError extends Error {
	readonly code = 'RECIPIENT_WORKSPACE_INTEGRITY_ERROR';

	constructor() {
		super('The pinned recipient workspace failed its integrity check');
		this.name = 'RecipientWorkspaceIntegrityError';
	}
}

export class RecipientWorkspaceService implements RecipientWorkspaceApplicationPort {
	constructor(
		private readonly access: RecipientAccessApplicationPort,
		private readonly readRevision: RecipientRevisionReader,
		private readonly readFields: RecipientFieldReader,
		private readonly now: () => Date = (): Date => new Date()
	) {}

	async resolve(token: string, at: string): Promise<RecipientWorkspace | null> {
		const before: RecipientSigningContext | null = await this.access.resolve(token, at);
		if (before === null) return null;

		const revision: ImmutableDraftRevision = {
			organizationId: before.organizationId,
			envelopeId: before.envelopeId,
			...before.sentRevision
		};
		const documents: readonly DraftDocument[] = await this.readRevision(revision);
		if (documents.length === 0) throw new RecipientWorkspaceIntegrityError();
		const ownFields: RecipientOwnFields | null = await this.readFields({
			organizationId: before.organizationId,
			envelopeId: before.envelopeId,
			recipientId: before.recipientId
		});
		if (ownFields === null) throw new RecipientWorkspaceIntegrityError();

		// A capability can be revoked while object storage and Git are being read.
		// Re-resolve immediately before disclosure and require the same pinned source.
		const after: RecipientSigningContext | null = await this.access.resolve(
			token,
			this.now().toISOString()
		);
		if (after === null) return null;
		if (!sameAuthorizationBoundary(before, after)) {
			throw new RecipientWorkspaceIntegrityError();
		}

		return {
			access: toPublicRecipientAccess(after),
			documents,
			fields: ownFields.fields,
			fieldGeneration: ownFields.fieldGeneration
		};
	}
}

function sameAuthorizationBoundary(
	left: RecipientSigningContext,
	right: RecipientSigningContext
): boolean {
	return (
		left.organizationId === right.organizationId &&
		left.envelopeId === right.envelopeId &&
		left.recipientId === right.recipientId &&
		left.sentRevision.commitSha === right.sentRevision.commitSha &&
		left.sentRevision.archiveKey === right.sentRevision.archiveKey &&
		left.sentRevision.archiveSha256 === right.sentRevision.archiveSha256
	);
}
