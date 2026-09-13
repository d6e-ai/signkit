import { env } from '$env/dynamic/private';
import { EnvelopeExpiryDrainService } from './envelope-expiry-service';

export interface EnvelopeExpiryRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveEnvelopeExpiryDrainService(
	context: EnvelopeExpiryRuntimeContext
): Promise<EnvelopeExpiryDrainService | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		const { D1EnvelopeExpiryStore } = await import('$lib/adapters/db/d1-envelope-expiry-store');
		return new EnvelopeExpiryDrainService(new D1EnvelopeExpiryStore(database));
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const [{ PostgresEnvelopeExpiryStore }, { resolvePostgresSql }] = await Promise.all([
		import('$lib/adapters/db/postgres-envelope-expiry-store'),
		import('$lib/application/envelopes/runtime-postgres')
	]);
	return new EnvelopeExpiryDrainService(
		new PostgresEnvelopeExpiryStore(resolvePostgresSql(databaseUrl))
	);
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
