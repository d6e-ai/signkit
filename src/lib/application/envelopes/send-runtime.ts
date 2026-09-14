import { env } from '$env/dynamic/private';
import { D1EnvelopeSendStore } from '$lib/adapters/db/d1-envelope-send-store';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import {
	SentDocumentPdfService,
	type SentDocumentPdfPort
} from '$lib/application/documents/sent-document-pdf';
import { AesGcmRecipientCapabilitySealer } from '$lib/security/delivery-capability';
import { EnvelopeSendApplication, type EnvelopeSendApplicationPort } from './send';

export interface EnvelopeSendRuntimeContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export async function resolveEnvelopeSendApplication(
	context: EnvelopeSendRuntimeContext
): Promise<EnvelopeSendApplicationPort | null> {
	const encodedKey: string | undefined = env.DELIVERY_ENCRYPTION_KEY;
	if (encodedKey === undefined || encodedKey.trim().length === 0) return null;
	const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(encodedKey);
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const bucket: R2Bucket | undefined = context.platform.env.OBJECTS;
		// Sending now materializes the recipient-facing PDF, so object storage
		// is no longer optional for this command: without it there is nothing to
		// pin, and a send that cannot pin its own rendering must not proceed.
		if (database === undefined || bucket === undefined) return null;
		const documentPdf: SentDocumentPdfPort = new SentDocumentPdfService(
			new R2ObjectStore(bucket),
			new IsomorphicGitDraftRepository()
		);
		return new EnvelopeSendApplication(new D1EnvelopeSendStore(database), sealer, documentPdf);
	}
	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl !== undefined && databaseUrl.trim().length > 0) {
		const { resolveS3ObjectStore } = await import('$lib/application/drafts/runtime-s3');
		const { resolvePostgresEnvelopeSendApplication } = await import('./runtime-postgres');
		const documentPdf: SentDocumentPdfPort = new SentDocumentPdfService(
			resolveS3ObjectStore({
				databaseUrl,
				endpoint: env.S3_ENDPOINT,
				region: env.S3_REGION,
				bucket: env.S3_BUCKET,
				accessKeyId: env.S3_ACCESS_KEY_ID,
				secretAccessKey: env.S3_SECRET_ACCESS_KEY,
				forcePathStyle: env.S3_FORCE_PATH_STYLE
			}),
			new IsomorphicGitDraftRepository()
		);
		return resolvePostgresEnvelopeSendApplication(databaseUrl, sealer, documentPdf);
	}
	return null;
}
