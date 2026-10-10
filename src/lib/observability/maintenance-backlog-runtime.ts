import { env } from '$env/dynamic/private';
import type { MaintenanceBacklogPort } from './maintenance-backlog';

export interface MaintenanceBacklogRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/**
 * Resolves the same durable database the drain routes already read from,
 * read-only: D1 on Cloudflare, the shared PostgreSQL pool everywhere else.
 */
export async function resolveMaintenanceBacklogPort(
	context: MaintenanceBacklogRuntimeContext
): Promise<MaintenanceBacklogPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		const { D1MaintenanceBacklog } = await import('./maintenance-backlog-d1');
		return new D1MaintenanceBacklog(database);
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const [{ PostgresMaintenanceBacklog }, { resolvePostgresSql }] = await Promise.all([
		import('./maintenance-backlog-postgres'),
		import('$lib/application/envelopes/runtime-postgres')
	]);
	return new PostgresMaintenanceBacklog(resolvePostgresSql(databaseUrl));
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
