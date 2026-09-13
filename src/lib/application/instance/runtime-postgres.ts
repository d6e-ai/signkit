import { PostgresInstanceStore } from '$lib/adapters/db/postgres-instance-store';
import { resolvePostgresSql } from '$lib/application/envelopes/runtime-postgres';
import {
	InstanceInvitationApplication,
	type InstanceInvitationApplicationPort
} from '$lib/application/instance-invitations/instance-invitation-service';
import {
	InstanceMemberApplication,
	type InstanceMemberApplicationPort
} from '$lib/application/instance-members/instance-member-service';
import { InstanceApplication, type InstanceApplicationPort } from './instance-service';

/**
 * Share the process-local PostgreSQL pool used by the rest of the Node and
 * Vercel runtimes.
 */
export function resolvePostgresInstanceApplication(databaseUrl: string): InstanceApplicationPort {
	return new InstanceApplication(new PostgresInstanceStore(resolvePostgresSql(databaseUrl)));
}

/**
 * Share the process-local PostgreSQL pool used by the rest of the Node and
 * Vercel runtimes.
 */
export function resolvePostgresInstanceInvitationApplication(
	databaseUrl: string
): InstanceInvitationApplicationPort {
	return new InstanceInvitationApplication(
		new PostgresInstanceStore(resolvePostgresSql(databaseUrl))
	);
}

/**
 * Share the process-local PostgreSQL pool used by the rest of the Node and
 * Vercel runtimes.
 */
export function resolvePostgresInstanceMemberApplication(
	databaseUrl: string
): InstanceMemberApplicationPort {
	return new InstanceMemberApplication(new PostgresInstanceStore(resolvePostgresSql(databaseUrl)));
}
