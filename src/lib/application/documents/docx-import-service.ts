import type {
	CommitDraftResult,
	DraftPersistenceService
} from '$lib/application/drafts/draft-persistence';
import type { DraftActor } from '$lib/ports/draft-repository';
import {
	importDocxToMarkdown,
	NODE_DOCX_IMPORT_LIMITS,
	type DocxImportLimits
} from '$lib/adapters/documents/docx-import';

export interface DocxImportCommitInput {
	organizationId: string;
	envelopeId: string;
	targetPath: `documents/${string}.md`;
	expectedGeneration: number;
	actor: DraftActor;
	idempotencyKey: string;
	docxBytes: Uint8Array;
	limits?: DocxImportLimits;
}

/**
 * Converts a hostile, untrusted DOCX upload into normalized Markdown and
 * commits it as one draft document edit through the existing, fully-audited
 * `DraftPersistenceService.commit` boundary. This introduces no new commit
 * path or bypass of `expectedGeneration`/idempotency: the DOCX is purely an
 * alternate input format for one `documents/*.md` edit.
 */
export class DocxImportService {
	constructor(private readonly drafts: Pick<DraftPersistenceService, 'commit'>) {}

	async importAndCommit(input: DocxImportCommitInput): Promise<CommitDraftResult> {
		const markdown: string = importDocxToMarkdown(
			input.docxBytes,
			input.limits ?? NODE_DOCX_IMPORT_LIMITS
		);
		return this.drafts.commit({
			organizationId: input.organizationId,
			envelopeId: input.envelopeId,
			expectedGeneration: input.expectedGeneration,
			edits: [{ path: input.targetPath, content: markdown }],
			message: `Import ${input.targetPath} from DOCX`,
			actor: input.actor,
			idempotencyKey: input.idempotencyKey
		});
	}
}
