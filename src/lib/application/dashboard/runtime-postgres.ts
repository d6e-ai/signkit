import { PostgresDashboardStore } from '$lib/adapters/db/postgres-dashboard-store';
import { resolvePostgresSql } from '$lib/application/runtime/postgres-sql-runtime';
import { DashboardApplication, type DashboardApplicationPort } from './dashboard-service';

export function resolvePostgresDashboardApplication(databaseUrl: string): DashboardApplicationPort {
	return new DashboardApplication(new PostgresDashboardStore(resolvePostgresSql(databaseUrl)));
}
