import { describe, expect, it } from 'vitest';
import { PdfSealDownloadService } from './pdf-seal-download';
import { resolvePdfSealDownloadApplication } from './pdf-seal-download-runtime';

function platform(bindings: { DB?: D1Database; OBJECTS?: R2Bucket }): Readonly<App.Platform> {
	return { env: bindings } as unknown as Readonly<App.Platform>;
}

describe('PDF seal download runtime', () => {
	it('resolves D1/R2 without requiring a current provider or validator policy', async () => {
		const application = await resolvePdfSealDownloadApplication({
			platform: platform({
				DB: {} as D1Database,
				OBJECTS: {} as R2Bucket
			})
		});
		expect(application).toBeInstanceOf(PdfSealDownloadService);
	});

	it('fails closed when either durable Cloudflare binding is absent', async () => {
		await expect(
			resolvePdfSealDownloadApplication({
				platform: platform({ DB: {} as D1Database })
			})
		).resolves.toBeNull();
		await expect(
			resolvePdfSealDownloadApplication({
				platform: platform({ OBJECTS: {} as R2Bucket })
			})
		).resolves.toBeNull();
	});
});
