import { resolveEnvelopeDocumentDependencies } from '$lib/application/runtime/envelope-document-dependencies-runtime';
import {
	EnvelopeDocumentPdfService,
	type EnvelopeDocumentPdfApplicationPort
} from './envelope-document-pdf';
import { SentDocumentPdfService } from './sent-document-pdf';

export interface EnvelopeDocumentPdfRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/**
 * Rendering the placement PDF needs the envelope pointer, object store, and
 * Git repository shared by every commit-pinned document feature, resolved
 * from the feature-neutral entry point rather than another feature's
 * runtime.
 */
export async function resolveEnvelopeDocumentPdfApplication(
	context: EnvelopeDocumentPdfRuntimeContext
): Promise<EnvelopeDocumentPdfApplicationPort | null> {
	const dependencies = await resolveEnvelopeDocumentDependencies(context);
	if (dependencies === null) return null;
	return new EnvelopeDocumentPdfService(
		dependencies.envelopes,
		new SentDocumentPdfService(dependencies.objects, dependencies.repository)
	);
}
