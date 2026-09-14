/**
 * Field placement is only valid against the page map of the envelope's current
 * ready revision. A map fetched while draft, or for an older commit, must not
 * become usable after draft→ready or after import/commit.
 */

export interface EnvelopeDocumentPageMap {
	commitSha: string;
	generation: number;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
	documents: readonly { path: string; title: string; firstPage: number; lastPage: number }[];
}

export interface PageMapRevision {
	status: string;
	repositoryHead: string | null;
	repositoryGeneration: number;
}

export function fieldPlacementReady(input: {
	status: string | undefined;
	hasSigners: boolean;
	pageMap: EnvelopeDocumentPageMap | null;
}): boolean {
	return input.status === 'ready' && input.hasSigners && input.pageMap !== null;
}

/** Draft import/commit must drop any previously fetched map. */
export function invalidateDocumentPageMap(): null {
	return null;
}

export function acceptCurrentRevisionPageMap(
	revision: PageMapRevision | null,
	pageMap: EnvelopeDocumentPageMap | null
): EnvelopeDocumentPageMap | null {
	if (revision === null || pageMap === null || revision.status !== 'ready') return null;
	if (pageMap.commitSha !== revision.repositoryHead) return null;
	if (pageMap.generation !== revision.repositoryGeneration) return null;
	return pageMap;
}

/**
 * Load pages only after the envelope is ready. Failures and non-ready statuses
 * leave the map null so placement stays gated off.
 */
export async function refreshDocumentPageMap(options: {
	revision: PageMapRevision | null;
	loadPages: () => Promise<EnvelopeDocumentPageMap | null>;
}): Promise<EnvelopeDocumentPageMap | null> {
	if (options.revision === null || options.revision.status !== 'ready') return null;
	try {
		return acceptCurrentRevisionPageMap(options.revision, await options.loadPages());
	} catch {
		return null;
	}
}

/**
 * Explicit ready-transition sequence: reload the envelope, then fetch pages for
 * that revision. Callers must null the map before awaiting this so placement
 * cannot enable against a stale map while reload runs.
 */
export async function refreshDocumentPageMapAfterReload(options: {
	reload: () => Promise<PageMapRevision | null>;
	loadPages: () => Promise<EnvelopeDocumentPageMap | null>;
}): Promise<EnvelopeDocumentPageMap | null> {
	const revision: PageMapRevision | null = await options.reload();
	return refreshDocumentPageMap({ revision, loadPages: options.loadPages });
}
