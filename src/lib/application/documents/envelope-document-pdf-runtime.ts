import { resolveEnvelopeDocxExport } from './docx-export-runtime';
import {
	EnvelopeDocumentPdfService,
	type EnvelopeDocumentPdfApplicationPort
} from './envelope-document-pdf';
import { SentDocumentPdfService } from './sent-document-pdf';

export interface EnvelopeDocumentPdfRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/**
 * Reuses the commit-pinned export dependencies: rendering the placement PDF
 * needs exactly the same envelope pointer, object store, and Git repository
 * that DOCX export already resolves, and sharing them keeps one answer to
 * "which durable stores is this deployment actually configured with".
 */
export async function resolveEnvelopeDocumentPdfApplication(
	context: EnvelopeDocumentPdfRuntimeContext
): Promise<EnvelopeDocumentPdfApplicationPort | null> {
	const dependencies = await resolveEnvelopeDocxExport(context);
	if (dependencies === null) return null;
	return new EnvelopeDocumentPdfService(
		dependencies.envelopes,
		new SentDocumentPdfService(dependencies.objects, dependencies.repository)
	);
}
