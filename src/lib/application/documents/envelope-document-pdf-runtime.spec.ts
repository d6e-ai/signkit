import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type { EnvelopeDocumentDependencies } from '$lib/application/runtime/envelope-document-dependencies-runtime';

const resolveEnvelopeDocumentDependencies = vi.hoisted(() =>
	vi.fn<(context: unknown) => Promise<EnvelopeDocumentDependencies | null>>()
);

vi.mock('$lib/application/runtime/envelope-document-dependencies-runtime', () => ({
	resolveEnvelopeDocumentDependencies
}));

import { resolveEnvelopeDocumentPdfApplication } from './envelope-document-pdf-runtime';
import { EnvelopeDocumentPdfService } from './envelope-document-pdf';

describe('resolveEnvelopeDocumentPdfApplication', () => {
	it('returns null when the shared document dependencies are not configured', async () => {
		resolveEnvelopeDocumentDependencies.mockResolvedValueOnce(null);

		await expect(resolveEnvelopeDocumentPdfApplication({})).resolves.toBeNull();
	});

	it('builds the service from the feature-neutral shared dependencies, not a DOCX export runtime', async () => {
		const dependencies: EnvelopeDocumentDependencies = {
			envelopes: { findEnvelope: vi.fn() },
			objects: {
				put: vi.fn(),
				get: vi.fn(),
				head: vi.fn(),
				delete: vi.fn()
			} as unknown as EnvelopeDocumentDependencies['objects'],
			repository: {} as EnvelopeDocumentDependencies['repository']
		};
		resolveEnvelopeDocumentDependencies.mockResolvedValueOnce(dependencies);

		const service = await resolveEnvelopeDocumentPdfApplication({});
		expect(service).toBeInstanceOf(EnvelopeDocumentPdfService);
		expect(resolveEnvelopeDocumentDependencies).toHaveBeenCalledWith({});
	});

	it('no longer imports or depends on the DOCX export runtime', () => {
		const source = readFileSync(
			new URL('./envelope-document-pdf-runtime.ts', import.meta.url),
			'utf8'
		);
		expect(source).not.toContain('docx-export');

		const docxExportRuntimePath = new URL('./docx-export-runtime.ts', import.meta.url);
		expect(existsSync(docxExportRuntimePath)).toBe(false);
	});
});
