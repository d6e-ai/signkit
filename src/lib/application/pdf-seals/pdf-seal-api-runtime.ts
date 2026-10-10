import { env } from '$env/dynamic/private';
import { D1PdfSealRequestStore } from '$lib/adapters/db/d1-pdf-seal-request-store';
import type { PdfSealApiRuntime } from '$lib/http/pdf-seal';
import type { PdfSealRequestStore } from '$lib/ports/pdf-seal-request-store';
import { PdfSealApiApplication } from './pdf-seal-api';
import { resolvePdfSealRequestPolicy } from './pdf-seal-runtime';

export interface PdfSealApiRuntimeContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export async function resolvePdfSealApiRuntime(
	context: PdfSealApiRuntimeContext
): Promise<PdfSealApiRuntime | null> {
	const platformEnv = context.platform?.env;
	let store: PdfSealRequestStore;
	if (platformEnv !== undefined) {
		if (platformEnv.DB === undefined) return null;
		store = new D1PdfSealRequestStore(platformEnv.DB);
	} else {
		const databaseUrl: string | undefined = nonEmpty(env.DATABASE_URL);
		if (databaseUrl === undefined) return null;
		const [adapter, postgresRuntime] = await Promise.all([
			import('$lib/adapters/db/postgres-pdf-seal-request-store'),
			import('$lib/application/envelopes/runtime-postgres')
		]);
		store = new adapter.PostgresPdfSealRequestStore(
			postgresRuntime.resolvePostgresSql(databaseUrl)
		);
	}
	return {
		application: new PdfSealApiApplication(store),
		requestPolicy: resolvePdfSealRequestPolicy({ platform: context.platform })
	};
}

function nonEmpty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
