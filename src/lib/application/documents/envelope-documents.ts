import type { EnvelopeDocument } from '$lib/domain/envelope';
import { assertMarkdownPath } from '$lib/domain/envelope';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import type {
	EnvelopeDocumentInput,
	EnvelopeDocumentStore
} from '$lib/ports/envelope-document-store';

const MAX_TITLE_LENGTH: number = 200;
const MAX_DOCUMENTS: number = 50;

export class InvalidEnvelopeDocumentInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidEnvelopeDocumentInputError';
	}
}

/**
 * Derives a readable title from a `documents/<name>.md` path: strip the
 * directory and extension, replace separators with spaces, and title-case
 * each word. Used only the first time a path is observed; a document that
 * already has a stored title keeps it across every later sync.
 */
export function titleFromMarkdownPath(markdownPath: string): string {
	const base: string = markdownPath.replace(/^documents\//, '').replace(/\.md$/, '');
	const spaced: string = base.replaceAll(/[-_]+/g, ' ').trim();
	const title: string = spaced
		.split(' ')
		.filter((word: string): boolean => word.length > 0)
		.map((word: string): string => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
	return title.length > 0 ? title.slice(0, MAX_TITLE_LENGTH) : 'Untitled document';
}

export interface EnvelopeDocumentApplicationPort {
	list(actor: EnvelopeRequestActor, envelopeId: string): Promise<readonly EnvelopeDocument[]>;
	syncFromPaths(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		markdownPaths: readonly string[]
	): Promise<readonly EnvelopeDocument[]>;
	rename(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		markdownPath: string,
		title: string
	): Promise<EnvelopeDocument | null>;
}

export class EnvelopeDocumentApplication implements EnvelopeDocumentApplicationPort {
	constructor(private readonly store: EnvelopeDocumentStore) {}

	async list(
		actor: EnvelopeRequestActor,
		envelopeId: string
	): Promise<readonly EnvelopeDocument[]> {
		return this.store.listForEnvelope(actor.organizationId, envelopeId);
	}

	async syncFromPaths(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		markdownPaths: readonly string[]
	): Promise<readonly EnvelopeDocument[]> {
		if (markdownPaths.length > MAX_DOCUMENTS) {
			throw new InvalidEnvelopeDocumentInputError(
				`An envelope may track at most ${MAX_DOCUMENTS} documents`
			);
		}
		const seen: Set<string> = new Set<string>();
		const inputs: EnvelopeDocumentInput[] = markdownPaths.map(
			(path: string): EnvelopeDocumentInput => {
				assertMarkdownPath(path);
				if (seen.has(path)) {
					throw new InvalidEnvelopeDocumentInputError('Duplicate document path in sync input');
				}
				seen.add(path);
				return { markdownPath: path };
			}
		);
		return this.store.sync(actor.organizationId, envelopeId, inputs);
	}

	async rename(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		markdownPath: string,
		title: string
	): Promise<EnvelopeDocument | null> {
		assertMarkdownPath(markdownPath);
		const trimmed: string = title.trim();
		if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH || hasControlCharacter(trimmed)) {
			throw new InvalidEnvelopeDocumentInputError('Document title is invalid');
		}
		return this.store.renameDocument(actor.organizationId, envelopeId, markdownPath, trimmed);
	}
}

function hasControlCharacter(value: string): boolean {
	for (let index: number = 0; index < value.length; index += 1) {
		const code: number = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}
