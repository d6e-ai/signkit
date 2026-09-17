import { PostgresContactStore } from '$lib/adapters/db/postgres-contact-store';
import { resolvePostgresSql } from '$lib/application/envelopes/runtime-postgres';
import { ContactApplication, type ContactApplicationPort } from './contact-service';

export function resolvePostgresContactApplication(databaseUrl: string): ContactApplicationPort {
	return new ContactApplication(new PostgresContactStore(resolvePostgresSql(databaseUrl)));
}
