import { describe, expect, it, vi } from 'vitest';
import {
	acceptCurrentRevisionPageMap,
	type EnvelopeDocumentPageMap,
	fieldPlacementReady,
	invalidateDocumentPageMap,
	type PageMapRevision,
	refreshDocumentPageMap,
	refreshDocumentPageMapAfterReload
} from './document-page-map';

const stale: EnvelopeDocumentPageMap = {
	commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	generation: 1,
	pageCount: 1,
	pageWidth: 595.28,
	pageHeight: 841.89,
	documents: [{ path: 'documents/agreement.md', title: 'agreement', firstPage: 1, lastPage: 1 }]
};

const current: EnvelopeDocumentPageMap = {
	...stale,
	commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
	generation: 2,
	pageCount: 3
};

const readyRevision: PageMapRevision = {
	status: 'ready',
	repositoryHead: current.commitSha,
	repositoryGeneration: current.generation
};

describe('authoring document page map', () => {
	it('invalidates a draft map so later ready status cannot enable stale placement', () => {
		expect(fieldPlacementReady({ status: 'ready', hasSigners: true, pageMap: stale })).toBe(true);
		const pageMap: EnvelopeDocumentPageMap | null = invalidateDocumentPageMap();
		expect(pageMap).toBeNull();
		expect(fieldPlacementReady({ status: 'draft', hasSigners: true, pageMap })).toBe(false);
		expect(fieldPlacementReady({ status: 'ready', hasSigners: true, pageMap })).toBe(false);
	});

	it('rejects a map that does not match the current ready revision', () => {
		expect(acceptCurrentRevisionPageMap(readyRevision, stale)).toBeNull();
		expect(
			fieldPlacementReady({
				status: 'ready',
				hasSigners: true,
				pageMap: acceptCurrentRevisionPageMap(readyRevision, stale)
			})
		).toBe(false);
		expect(acceptCurrentRevisionPageMap(readyRevision, current)).toEqual(current);
	});

	it('does not load pages while the envelope is still draft', async () => {
		const loadPages = vi.fn(async (): Promise<EnvelopeDocumentPageMap | null> => current);
		const pageMap: EnvelopeDocumentPageMap | null = await refreshDocumentPageMap({
			revision: {
				status: 'draft',
				repositoryHead: current.commitSha,
				repositoryGeneration: current.generation
			},
			loadPages
		});
		expect(loadPages).not.toHaveBeenCalled();
		expect(pageMap).toBeNull();
	});

	it('keeps placement gated until pages for the post-reload revision arrive', async () => {
		let pageMap: EnvelopeDocumentPageMap | null = invalidateDocumentPageMap();

		let releasePages: (value: EnvelopeDocumentPageMap) => void = (): void => undefined;
		const pages: Promise<EnvelopeDocumentPageMap> = new Promise((resolve) => {
			releasePages = resolve;
		});
		const reload = vi.fn(async (): Promise<PageMapRevision> => readyRevision);
		const loadPages = vi.fn((): Promise<EnvelopeDocumentPageMap | null> => pages);

		const inFlight: Promise<EnvelopeDocumentPageMap | null> = refreshDocumentPageMapAfterReload({
			reload,
			loadPages
		});

		await vi.waitFor(() => {
			expect(reload).toHaveBeenCalledTimes(1);
			expect(loadPages).toHaveBeenCalledTimes(1);
		});
		expect(fieldPlacementReady({ status: 'ready', hasSigners: true, pageMap })).toBe(false);

		releasePages(current);
		pageMap = await inFlight;
		expect(pageMap).toEqual(current);
		expect(fieldPlacementReady({ status: 'ready', hasSigners: true, pageMap })).toBe(true);
	});

	it('leaves placement gated when page load fails or returns a stale revision', async () => {
		const failed: EnvelopeDocumentPageMap | null = await refreshDocumentPageMap({
			revision: readyRevision,
			loadPages: async (): Promise<EnvelopeDocumentPageMap | null> => {
				throw new Error('unavailable');
			}
		});
		expect(failed).toBeNull();
		expect(fieldPlacementReady({ status: 'ready', hasSigners: true, pageMap: failed })).toBe(false);

		const staleFetch: EnvelopeDocumentPageMap | null = await refreshDocumentPageMap({
			revision: readyRevision,
			loadPages: async (): Promise<EnvelopeDocumentPageMap | null> => stale
		});
		expect(staleFetch).toBeNull();
		expect(fieldPlacementReady({ status: 'ready', hasSigners: true, pageMap: staleFetch })).toBe(
			false
		);
	});
});
