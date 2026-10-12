import { env } from '$env/dynamic/private';
import { D1DashboardStore } from '$lib/adapters/db/d1-dashboard-store';
import { DashboardApplication, type DashboardApplicationPort } from './dashboard-service';

export interface DashboardRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/**
 * Resolve the dashboard application only for a durable store configured for
 * the active deployment target: the D1 binding on Cloudflare, otherwise
 * PostgreSQL from DATABASE_URL. The PostgreSQL path stays behind a dynamic
 * import so the Node driver is never pulled into the Worker bundle.
 */
export async function resolveDashboardApplication(
	context: DashboardRuntimeContext
): Promise<DashboardApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		return database === undefined ? null : new DashboardApplication(new D1DashboardStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresDashboardApplication } = await import('./runtime-postgres');
	return resolvePostgresDashboardApplication(databaseUrl);
}
