import postgres from 'postgres';
import {
	MAX_CONTACT_LIST_LIMIT,
	type ContactActor,
	type ContactListQuery,
	type ContactMetadata,
	type ContactStore,
	type CreateContactCommand,
	type CreateContactStoreResult,
	type DeleteContactCommand,
	type DeleteContactStoreResult,
	type ListContactsStoreResult,
	type UpdateContactCommand,
	type UpdateContactStoreResult
} from '$lib/ports/contact-store';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

interface ContactRow {
	id: string;
	name: string;
	email: string;
	locale: string;
	version: number;
	createdAt: Date | string;
	updatedAt: Date | string;
}

interface CommandRow {
	commandType: string;
	requestHash: string;
	contactId: string;
	resultVersion: number;
	occurredAt: Date | string;
}

class ContactRollback<T> extends Error {
	constructor(readonly result: T) {
		super('Contact transaction rolled back');
	}
}

const COLUMNS: string = `id, name, email, locale, version,
	created_at AS "createdAt", updated_at AS "updatedAt"`;

export class PostgresContactStore implements ContactStore {
	constructor(private readonly sql: ReturnType<typeof postgres>) {}

	async createContact(command: CreateContactCommand): Promise<CreateContactStoreResult> {
		try {
			return await this.sql.begin(async (tx): Promise<CreateContactStoreResult> => {
				await requireActiveOwner(tx, command.actor.id, false);
				const replay = await readReceipt(tx, command.actor.id, command.idempotencyKey);
				if (replay !== undefined) {
					if (replay.commandType !== 'create' || replay.requestHash !== command.requestFingerprint)
						return { outcome: 'idempotency_conflict' };
					const current = await readContact(tx, command.actor.id, replay.contactId);
					return current === undefined
						? { outcome: 'integrity_error' }
						: { outcome: 'replayed', contact: fromRow(current) };
				}
				if ((await tx`SELECT 1 FROM contact WHERE id = ${command.contactId} LIMIT 1`).length > 0) {
					return { outcome: 'id_conflict' };
				}
				if (
					(
						await tx`SELECT 1 FROM contact WHERE owner_user_id = ${command.actor.id} AND email = ${command.email} LIMIT 1`
					).length > 0
				) {
					return { outcome: 'email_conflict' };
				}
				const rows = await tx<ContactRow[]>`
					INSERT INTO contact (id, owner_user_id, name, name_search, email, locale, version,
						created_at, updated_at, last_command_hash)
					VALUES (${command.contactId}, ${command.actor.id}, ${command.name}, ${command.nameSearch},
						${command.email}, ${command.locale}, 1, ${command.occurredAt}::timestamptz,
						${command.occurredAt}::timestamptz, ${command.commandMarker})
					RETURNING ${tx.unsafe(COLUMNS)}`;
				await insertReceipt(tx, command, 'create', null, 1);
				return { outcome: 'created', contact: fromRow(rows[0]) };
			});
		} catch (error: unknown) {
			if (error instanceof ContactRollback) return error.result as CreateContactStoreResult;
			return await this.classifyCreateFailure(command);
		}
	}

	async listContacts(
		actor: ContactActor,
		query: ContactListQuery
	): Promise<ListContactsStoreResult> {
		if (query.limit < 1 || query.limit > MAX_CONTACT_LIST_LIMIT)
			throw new RangeError('Invalid limit');
		try {
			return await this.sql.begin(async (tx): Promise<ListContactsStoreResult> => {
				await requireActiveOwner(tx, actor.id, false);
				const pattern: string | null = query.query === null ? null : `%${escapeLike(query.query)}%`;
				let rows: ContactRow[];
				const fetchLimit: number = query.limit + 1;
				if (query.cursor === null && pattern === null) {
					rows = await tx<ContactRow[]>`SELECT ${tx.unsafe(COLUMNS)} FROM contact
						WHERE owner_user_id = ${actor.id}
						ORDER BY name_search COLLATE "C", email COLLATE "C", id COLLATE "C" LIMIT ${fetchLimit}`;
				} else if (query.cursor === null) {
					rows = await tx<ContactRow[]>`SELECT ${tx.unsafe(COLUMNS)} FROM contact
						WHERE owner_user_id = ${actor.id} AND (name_search LIKE ${pattern} ESCAPE '\\' OR email LIKE ${pattern} ESCAPE '\\')
						ORDER BY name_search COLLATE "C", email COLLATE "C", id COLLATE "C" LIMIT ${fetchLimit}`;
				} else {
					const cursor =
						pattern === null
							? await tx<{ nameSearch: string; email: string; id: string }[]>`
								SELECT name_search AS "nameSearch", email, id FROM contact
								WHERE owner_user_id = ${actor.id} AND id = ${query.cursor} LIMIT 1`
							: await tx<{ nameSearch: string; email: string; id: string }[]>`
								SELECT name_search AS "nameSearch", email, id FROM contact
								WHERE owner_user_id = ${actor.id} AND id = ${query.cursor}
								AND (name_search LIKE ${pattern} ESCAPE '\\' OR email LIKE ${pattern} ESCAPE '\\') LIMIT 1`;
					if (cursor[0] === undefined)
						return { outcome: 'listed', page: { items: [], nextCursor: null } };
					const position = cursor[0];
					rows =
						pattern === null
							? await tx<ContactRow[]>`SELECT ${tx.unsafe(COLUMNS)} FROM contact
								WHERE owner_user_id = ${actor.id}
								AND (name_search COLLATE "C", email COLLATE "C", id COLLATE "C") >
									(${position.nameSearch} COLLATE "C", ${position.email} COLLATE "C", ${position.id} COLLATE "C")
								ORDER BY name_search COLLATE "C", email COLLATE "C", id COLLATE "C" LIMIT ${fetchLimit}`
							: await tx<ContactRow[]>`SELECT ${tx.unsafe(COLUMNS)} FROM contact
								WHERE owner_user_id = ${actor.id} AND (name_search LIKE ${pattern} ESCAPE '\\' OR email LIKE ${pattern} ESCAPE '\\')
								AND (name_search COLLATE "C", email COLLATE "C", id COLLATE "C") >
									(${position.nameSearch} COLLATE "C", ${position.email} COLLATE "C", ${position.id} COLLATE "C")
								ORDER BY name_search COLLATE "C", email COLLATE "C", id COLLATE "C" LIMIT ${fetchLimit}`;
				}
				const hasNext: boolean = rows.length > query.limit;
				const pageRows: ContactRow[] = hasNext ? rows.slice(0, query.limit) : rows;
				return {
					outcome: 'listed',
					page: {
						items: pageRows.map(fromRow),
						nextCursor: hasNext ? (pageRows.at(-1)?.id ?? null) : null
					}
				};
			});
		} catch (error: unknown) {
			if (error instanceof ContactRollback) return error.result as ListContactsStoreResult;
			throw error;
		}
	}

	async updateContact(command: UpdateContactCommand): Promise<UpdateContactStoreResult> {
		try {
			return await this.sql.begin(async (tx): Promise<UpdateContactStoreResult> => {
				await requireActiveOwner(tx, command.actor.id, false);
				const replay = await readReceipt(tx, command.actor.id, command.idempotencyKey);
				if (replay !== undefined) {
					if (!receiptMatches(replay, command, 'update'))
						return { outcome: 'idempotency_conflict' };
					const current = await readContact(tx, command.actor.id, command.contactId);
					return current === undefined
						? { outcome: 'integrity_error' }
						: { outcome: 'replayed', contact: fromRow(current) };
				}
				const current = await readContact(tx, command.actor.id, command.contactId, true);
				const concurrentReplay = await readReceipt(tx, command.actor.id, command.idempotencyKey);
				if (concurrentReplay !== undefined) {
					if (!receiptMatches(concurrentReplay, command, 'update'))
						return { outcome: 'idempotency_conflict' };
					return current === undefined
						? { outcome: 'integrity_error' }
						: { outcome: 'replayed', contact: fromRow(current) };
				}
				if (current === undefined) return { outcome: 'not_found' };
				if (current.version !== command.expectedVersion) return { outcome: 'version_conflict' };
				if (
					(
						await tx`SELECT 1 FROM contact WHERE owner_user_id = ${command.actor.id} AND email = ${command.email} AND id <> ${command.contactId} LIMIT 1`
					).length > 0
				) {
					return { outcome: 'email_conflict' };
				}
				const nextVersion: number = command.expectedVersion + 1;
				const rows = await tx<
					ContactRow[]
				>`UPDATE contact SET name = ${command.name}, name_search = ${command.nameSearch},
					email = ${command.email}, locale = ${command.locale}, version = ${nextVersion},
					updated_at = ${command.occurredAt}::timestamptz, last_command_hash = ${command.commandMarker}
					WHERE owner_user_id = ${command.actor.id} AND id = ${command.contactId} AND version = ${command.expectedVersion}
					RETURNING ${tx.unsafe(COLUMNS)}`;
				if (rows.length !== 1) return { outcome: 'integrity_error' };
				await insertReceipt(tx, command, 'update', command.expectedVersion, nextVersion);
				return { outcome: 'updated', contact: fromRow(rows[0]) };
			});
		} catch (error: unknown) {
			if (error instanceof ContactRollback) return error.result as UpdateContactStoreResult;
			return await this.classifyUpdateFailure(command);
		}
	}

	async deleteContact(command: DeleteContactCommand): Promise<DeleteContactStoreResult> {
		try {
			return await this.sql.begin(async (tx): Promise<DeleteContactStoreResult> => {
				await requireActiveOwner(tx, command.actor.id, false);
				const replay = await readReceipt(tx, command.actor.id, command.idempotencyKey);
				if (replay !== undefined) {
					if (!receiptMatches(replay, command, 'delete'))
						return { outcome: 'idempotency_conflict' };
					return {
						outcome: 'replayed',
						contactId: replay.contactId,
						deletedAt: iso(replay.occurredAt)
					};
				}
				const current = await readContact(tx, command.actor.id, command.contactId, true);
				const concurrentReplay = await readReceipt(tx, command.actor.id, command.idempotencyKey);
				if (concurrentReplay !== undefined) {
					if (!receiptMatches(concurrentReplay, command, 'delete'))
						return { outcome: 'idempotency_conflict' };
					return {
						outcome: 'replayed',
						contactId: concurrentReplay.contactId,
						deletedAt: iso(concurrentReplay.occurredAt)
					};
				}
				if (current === undefined) return { outcome: 'not_found' };
				if (current.version !== command.expectedVersion) return { outcome: 'version_conflict' };
				await insertReceipt(
					tx,
					command,
					'delete',
					command.expectedVersion,
					command.expectedVersion
				);
				const removed =
					await tx`DELETE FROM contact WHERE owner_user_id = ${command.actor.id} AND id = ${command.contactId} AND version = ${command.expectedVersion} RETURNING id`;
				if (removed.length !== 1)
					throw new ContactRollback<DeleteContactStoreResult>({ outcome: 'integrity_error' });
				return { outcome: 'deleted', contactId: command.contactId, deletedAt: command.occurredAt };
			});
		} catch (error: unknown) {
			if (error instanceof ContactRollback) return error.result as DeleteContactStoreResult;
			return await this.classifyDeleteFailure(command);
		}
	}

	private async classifyCreateFailure(
		command: CreateContactCommand
	): Promise<CreateContactStoreResult> {
		try {
			return await this.sql.begin(async (tx): Promise<CreateContactStoreResult> => {
				await requireActiveOwner(tx, command.actor.id, false);
				const receipt = await readReceipt(tx, command.actor.id, command.idempotencyKey);
				if (receipt !== undefined) {
					if (
						receipt.commandType !== 'create' ||
						receipt.requestHash !== command.requestFingerprint
					) {
						return { outcome: 'idempotency_conflict' };
					}
					const current = await readContact(tx, command.actor.id, receipt.contactId);
					return current === undefined
						? { outcome: 'integrity_error' }
						: { outcome: 'replayed', contact: fromRow(current) };
				}
				const sameId = await tx`SELECT 1 FROM contact WHERE id = ${command.contactId} LIMIT 1`;
				if (sameId.length > 0) return { outcome: 'id_conflict' };
				const sameEmail = await tx`SELECT 1 FROM contact
					WHERE owner_user_id = ${command.actor.id} AND email = ${command.email} LIMIT 1`;
				return sameEmail.length > 0
					? { outcome: 'email_conflict' }
					: { outcome: 'integrity_error' };
			});
		} catch (error: unknown) {
			if (error instanceof ContactRollback) return error.result as CreateContactStoreResult;
			throw error;
		}
	}

	private async classifyUpdateFailure(
		command: UpdateContactCommand
	): Promise<UpdateContactStoreResult> {
		try {
			return await this.sql.begin(async (tx): Promise<UpdateContactStoreResult> => {
				await requireActiveOwner(tx, command.actor.id, false);
				const receipt = await readReceipt(tx, command.actor.id, command.idempotencyKey);
				if (receipt !== undefined) {
					if (!receiptMatches(receipt, command, 'update')) {
						return { outcome: 'idempotency_conflict' };
					}
					const current = await readContact(tx, command.actor.id, command.contactId);
					return current === undefined
						? { outcome: 'integrity_error' }
						: { outcome: 'replayed', contact: fromRow(current) };
				}
				const current = await readContact(tx, command.actor.id, command.contactId, true);
				if (current === undefined) return { outcome: 'not_found' };
				if (current.version !== command.expectedVersion) return { outcome: 'version_conflict' };
				const duplicate = await tx`SELECT 1 FROM contact
					WHERE owner_user_id = ${command.actor.id} AND email = ${command.email}
					AND id <> ${command.contactId} LIMIT 1`;
				return duplicate.length > 0
					? { outcome: 'email_conflict' }
					: { outcome: 'integrity_error' };
			});
		} catch (error: unknown) {
			if (error instanceof ContactRollback) return error.result as UpdateContactStoreResult;
			throw error;
		}
	}

	private async classifyDeleteFailure(
		command: DeleteContactCommand
	): Promise<DeleteContactStoreResult> {
		try {
			return await this.sql.begin(async (tx): Promise<DeleteContactStoreResult> => {
				await requireActiveOwner(tx, command.actor.id, false);
				const receipt = await readReceipt(tx, command.actor.id, command.idempotencyKey);
				if (receipt !== undefined) {
					if (!receiptMatches(receipt, command, 'delete')) {
						return { outcome: 'idempotency_conflict' };
					}
					return {
						outcome: 'replayed',
						contactId: receipt.contactId,
						deletedAt: iso(receipt.occurredAt)
					};
				}
				const current = await readContact(tx, command.actor.id, command.contactId, true);
				if (current === undefined) return { outcome: 'not_found' };
				if (current.version !== command.expectedVersion) return { outcome: 'version_conflict' };
				return { outcome: 'integrity_error' };
			});
		} catch (error: unknown) {
			if (error instanceof ContactRollback) return error.result as DeleteContactStoreResult;
			throw error;
		}
	}
}

async function requireActiveOwner(sql: Sql, actorId: string, exclusive: boolean): Promise<void> {
	const rows = exclusive
		? await sql<
				{ status: string }[]
			>`SELECT status FROM instance_member WHERE user_id = ${actorId} LIMIT 1 FOR UPDATE`
		: await sql<
				{ status: string }[]
			>`SELECT status FROM instance_member WHERE user_id = ${actorId} LIMIT 1 FOR SHARE`;
	if (rows[0]?.status !== 'active')
		throw new ContactRollback({ outcome: 'owner_not_active' as const });
}

async function readContact(
	sql: Sql,
	actorId: string,
	contactId: string,
	lock: boolean = false
): Promise<ContactRow | undefined> {
	const rows = lock
		? await sql<
				ContactRow[]
			>`SELECT ${sql.unsafe(COLUMNS)} FROM contact WHERE owner_user_id = ${actorId} AND id = ${contactId} LIMIT 1 FOR UPDATE`
		: await sql<
				ContactRow[]
			>`SELECT ${sql.unsafe(COLUMNS)} FROM contact WHERE owner_user_id = ${actorId} AND id = ${contactId} LIMIT 1`;
	return rows[0];
}

async function readReceipt(
	sql: Sql,
	actorId: string,
	key: string
): Promise<CommandRow | undefined> {
	const rows = await sql<
		CommandRow[]
	>`SELECT command_type AS "commandType", request_hash AS "requestHash",
		contact_id AS "contactId", result_version AS "resultVersion", occurred_at AS "occurredAt"
		FROM contact_command WHERE actor_id = ${actorId} AND idempotency_key = ${key} LIMIT 1`;
	return rows[0];
}

async function insertReceipt(
	sql: Sql,
	command: CreateContactCommand | UpdateContactCommand | DeleteContactCommand,
	type: 'create' | 'update' | 'delete',
	expectedVersion: number | null,
	resultVersion: number
): Promise<void> {
	await sql`INSERT INTO contact_command (actor_id, idempotency_key, command_type, request_hash,
		contact_id, expected_version, result_version, occurred_at) VALUES (
		${command.actor.id}, ${command.idempotencyKey}, ${type}, ${command.requestFingerprint},
		${command.contactId}, ${expectedVersion}, ${resultVersion}, ${command.occurredAt}::timestamptz)`;
}

function receiptMatches(
	receipt: CommandRow,
	command: CreateContactCommand | UpdateContactCommand | DeleteContactCommand,
	type: string
): boolean {
	return (
		receipt.commandType === type &&
		receipt.requestHash === command.requestFingerprint &&
		receipt.contactId === command.contactId
	);
}

function fromRow(row: ContactRow): ContactMetadata {
	if (row.locale !== 'en' && row.locale !== 'ja')
		throw new Error('Stored contact locale is invalid');
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		locale: row.locale,
		version: row.version,
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt)
	};
}

function iso(value: Date | string): string {
	const time: number = value instanceof Date ? value.valueOf() : Date.parse(value);
	if (!Number.isFinite(time)) throw new Error('Stored contact timestamp is invalid');
	return new Date(time).toISOString();
}

function escapeLike(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
