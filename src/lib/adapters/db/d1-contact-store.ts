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

interface ContactRow {
	id: string;
	name: string;
	email: string;
	locale: string;
	version: number;
	created_at: string;
	updated_at: string;
}

interface MemberRow {
	status: string;
}

interface CommandRow {
	command_type: string;
	request_hash: string;
	contact_id: string;
	result_version: number;
	occurred_at: string;
}

const COLUMNS: string = 'id, name, email, locale, version, created_at, updated_at';

export class D1ContactStore implements ContactStore {
	constructor(private readonly database: D1Database) {}

	async createContact(command: CreateContactCommand): Promise<CreateContactStoreResult> {
		const gate: CreateContactStoreResult | null = await this.createGate(command);
		if (gate !== null) return gate;
		const contact = this.database
			.prepare(
				`INSERT INTO contact (id, owner_user_id, name, name_search, email, locale, version,
				 created_at, updated_at, last_command_hash)
				 SELECT ?, user_id, ?, ?, ?, ?, 1, ?, ?, ? FROM instance_member
				 WHERE user_id = ? AND status = 'active'`
			)
			.bind(
				command.contactId,
				command.name,
				command.nameSearch,
				command.email,
				command.locale,
				command.occurredAt,
				command.occurredAt,
				command.commandMarker,
				command.actor.id
			);
		const receipt = this.database
			.prepare(
				`INSERT INTO contact_command (
					actor_id, idempotency_key, command_type, request_hash, contact_id,
					expected_version, result_version, occurred_at
				 ) SELECT ?, ?, 'create', ?, id, NULL, version, ? FROM contact
				 WHERE owner_user_id = ? AND id = ? AND version = 1`
			)
			.bind(
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.occurredAt,
				command.actor.id,
				command.contactId
			);
		try {
			const results: D1Result[] = await this.database.batch([contact, receipt]);
			if (results.every((result: D1Result): boolean => changes(result) === 1)) {
				return { outcome: 'created', contact: metadata(command, 1, command.occurredAt) };
			}
		} catch {
			// Classify only from durable evidence below; never from provider text.
		}
		return (await this.classifyCreate(command)) ?? { outcome: 'integrity_error' };
	}

	async listContacts(
		actor: ContactActor,
		query: ContactListQuery
	): Promise<ListContactsStoreResult> {
		if (query.limit < 1 || query.limit > MAX_CONTACT_LIST_LIMIT)
			throw new RangeError('Invalid limit');
		const member = this.database
			.prepare('SELECT status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(actor.id);
		const pattern: string | null = query.query === null ? null : `%${escapeLike(query.query)}%`;
		const filter: string =
			pattern === null ? '' : ` AND (name_search LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')`;
		const fetchLimit: number = query.limit + 1;
		let page: D1PreparedStatement;
		if (query.cursor === null) {
			page = this.database
				.prepare(
					`SELECT ${COLUMNS} FROM contact
					 WHERE owner_user_id = ?${filter}
					   AND EXISTS (SELECT 1 FROM instance_member WHERE user_id = ? AND status = 'active')
					 ORDER BY name_search COLLATE BINARY, email COLLATE BINARY, id COLLATE BINARY LIMIT ?`
				)
				.bind(
					...(pattern === null
						? [actor.id, actor.id, fetchLimit]
						: [actor.id, pattern, pattern, actor.id, fetchLimit])
				);
		} else {
			const cursorFilter: string =
				pattern === null ? '' : ` AND (name_search LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')`;
			page = this.database
				.prepare(
					`SELECT ${COLUMNS} FROM contact
					 WHERE owner_user_id = ?${filter}
					   AND EXISTS (SELECT 1 FROM instance_member WHERE user_id = ? AND status = 'active')
					   AND (name_search COLLATE BINARY, email COLLATE BINARY, id COLLATE BINARY) > (
						 SELECT name_search COLLATE BINARY, email COLLATE BINARY, id COLLATE BINARY FROM contact
						 WHERE owner_user_id = ? AND id = ?${cursorFilter} LIMIT 1
					   )
					 ORDER BY name_search COLLATE BINARY, email COLLATE BINARY, id COLLATE BINARY LIMIT ?`
				)
				.bind(
					...(pattern === null
						? [actor.id, actor.id, actor.id, query.cursor, fetchLimit]
						: [
								actor.id,
								pattern,
								pattern,
								actor.id,
								actor.id,
								query.cursor,
								pattern,
								pattern,
								fetchLimit
							])
				);
		}
		const results = await this.database.batch<MemberRow | ContactRow>([member, page]);
		const memberRow: MemberRow | undefined = results[0]?.results[0] as MemberRow | undefined;
		if (memberRow?.status !== 'active') return { outcome: 'owner_not_active' };
		const all: ContactRow[] = (results[1]?.results ?? []) as ContactRow[];
		const hasNext: boolean = all.length > query.limit;
		const rows: ContactRow[] = hasNext ? all.slice(0, query.limit) : all;
		return {
			outcome: 'listed',
			page: {
				items: rows.map(fromRow),
				nextCursor: hasNext ? (rows.at(-1)?.id ?? null) : null
			}
		};
	}

	async updateContact(command: UpdateContactCommand): Promise<UpdateContactStoreResult> {
		const gate: UpdateContactStoreResult | null = await this.updateGate(command);
		if (gate !== null) return gate;
		const nextVersion: number = command.expectedVersion + 1;
		const update = this.database
			.prepare(
				`UPDATE contact SET name = ?, name_search = ?, email = ?, locale = ?, version = ?,
				 updated_at = ?, last_command_hash = ?
				 WHERE owner_user_id = ? AND id = ? AND version = ?
				   AND EXISTS (SELECT 1 FROM instance_member WHERE user_id = ? AND status = 'active')`
			)
			.bind(
				command.name,
				command.nameSearch,
				command.email,
				command.locale,
				nextVersion,
				command.occurredAt,
				command.commandMarker,
				command.actor.id,
				command.contactId,
				command.expectedVersion,
				command.actor.id
			);
		const receipt = this.database
			.prepare(
				`INSERT INTO contact_command (
					actor_id, idempotency_key, command_type, request_hash, contact_id,
					expected_version, result_version, occurred_at
				 ) SELECT ?, ?, 'update', ?, id, ?, version, ? FROM contact
				 WHERE owner_user_id = ? AND id = ? AND version = ? AND last_command_hash = ?`
			)
			.bind(
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.expectedVersion,
				command.occurredAt,
				command.actor.id,
				command.contactId,
				nextVersion,
				command.commandMarker
			);
		try {
			const results: D1Result[] = await this.database.batch([update, receipt]);
			if (results.every((result: D1Result): boolean => changes(result) === 1)) {
				const current: ContactRow | null = await this.read(command.actor.id, command.contactId);
				return current === null
					? { outcome: 'integrity_error' }
					: { outcome: 'updated', contact: fromRow(current) };
			}
		} catch {
			// Classified below.
		}
		return (await this.classifyUpdate(command)) ?? { outcome: 'integrity_error' };
	}

	async deleteContact(command: DeleteContactCommand): Promise<DeleteContactStoreResult> {
		const gate: DeleteContactStoreResult | null = await this.deleteGate(command);
		if (gate !== null) return gate;
		const receipt = this.database
			.prepare(
				`INSERT INTO contact_command (
					actor_id, idempotency_key, command_type, request_hash, contact_id,
					expected_version, result_version, occurred_at
				 ) SELECT ?, ?, 'delete', ?, id, ?, version, ? FROM contact
				 WHERE owner_user_id = ? AND id = ? AND version = ?
				   AND EXISTS (SELECT 1 FROM instance_member WHERE user_id = ? AND status = 'active')`
			)
			.bind(
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.expectedVersion,
				command.occurredAt,
				command.actor.id,
				command.contactId,
				command.expectedVersion,
				command.actor.id
			);
		const remove = this.database
			.prepare(
				`DELETE FROM contact WHERE owner_user_id = ? AND id = ? AND version = ?
				 AND EXISTS (SELECT 1 FROM contact_command WHERE actor_id = ? AND idempotency_key = ?
				   AND command_type = 'delete' AND contact_id = contact.id)`
			)
			.bind(
				command.actor.id,
				command.contactId,
				command.expectedVersion,
				command.actor.id,
				command.idempotencyKey
			);
		try {
			const results: D1Result[] = await this.database.batch([receipt, remove]);
			if (results.every((result: D1Result): boolean => changes(result) === 1)) {
				return { outcome: 'deleted', contactId: command.contactId, deletedAt: command.occurredAt };
			}
		} catch {
			// Classified below.
		}
		return (await this.deleteGate(command)) ?? { outcome: 'integrity_error' };
	}

	private async createGate(
		command: CreateContactCommand
	): Promise<CreateContactStoreResult | null> {
		const snapshot = await this.snapshot(
			command.actor.id,
			command.idempotencyKey,
			command.contactId
		);
		if (snapshot.member?.status !== 'active') return { outcome: 'owner_not_active' };
		if (snapshot.receipt !== undefined) {
			if (
				snapshot.receipt.command_type !== 'create' ||
				snapshot.receipt.request_hash !== command.requestFingerprint
			)
				return { outcome: 'idempotency_conflict' };
			const replayed: ContactRow | null = await this.read(
				command.actor.id,
				snapshot.receipt.contact_id
			);
			return replayed === null
				? { outcome: 'integrity_error' }
				: { outcome: 'replayed', contact: fromRow(replayed) };
		}
		return null;
	}

	private async classifyCreate(
		command: CreateContactCommand
	): Promise<CreateContactStoreResult | null> {
		const gate: CreateContactStoreResult | null = await this.createGate(command);
		if (gate !== null) return gate;
		const sameId = await this.database
			.prepare('SELECT 1 FROM contact WHERE id = ?')
			.bind(command.contactId)
			.first();
		if (sameId !== null) return { outcome: 'id_conflict' };
		const sameEmail = await this.database
			.prepare('SELECT 1 FROM contact WHERE owner_user_id = ? AND email = ?')
			.bind(command.actor.id, command.email)
			.first();
		return sameEmail === null ? null : { outcome: 'email_conflict' };
	}

	private async updateGate(
		command: UpdateContactCommand
	): Promise<UpdateContactStoreResult | null> {
		const snapshot = await this.snapshot(
			command.actor.id,
			command.idempotencyKey,
			command.contactId
		);
		if (snapshot.member?.status !== 'active') return { outcome: 'owner_not_active' };
		if (snapshot.receipt !== undefined) {
			if (!receiptMatches(snapshot.receipt, command, 'update'))
				return { outcome: 'idempotency_conflict' };
			return snapshot.contact === undefined
				? { outcome: 'integrity_error' }
				: { outcome: 'replayed', contact: fromRow(snapshot.contact) };
		}
		if (snapshot.contact === undefined) return { outcome: 'not_found' };
		if (snapshot.contact.version !== command.expectedVersion)
			return { outcome: 'version_conflict' };
		return null;
	}

	private async classifyUpdate(
		command: UpdateContactCommand
	): Promise<UpdateContactStoreResult | null> {
		const gate: UpdateContactStoreResult | null = await this.updateGate(command);
		if (gate !== null) return gate;
		const duplicate = await this.database
			.prepare('SELECT 1 FROM contact WHERE owner_user_id = ? AND email = ? AND id <> ?')
			.bind(command.actor.id, command.email, command.contactId)
			.first();
		return duplicate === null ? null : { outcome: 'email_conflict' };
	}

	private async deleteGate(
		command: DeleteContactCommand
	): Promise<DeleteContactStoreResult | null> {
		const snapshot = await this.snapshot(
			command.actor.id,
			command.idempotencyKey,
			command.contactId
		);
		if (snapshot.member?.status !== 'active') return { outcome: 'owner_not_active' };
		if (snapshot.receipt !== undefined) {
			if (!receiptMatches(snapshot.receipt, command, 'delete'))
				return { outcome: 'idempotency_conflict' };
			return {
				outcome: 'replayed',
				contactId: snapshot.receipt.contact_id,
				deletedAt: snapshot.receipt.occurred_at
			};
		}
		if (snapshot.contact === undefined) return { outcome: 'not_found' };
		if (snapshot.contact.version !== command.expectedVersion)
			return { outcome: 'version_conflict' };
		return null;
	}

	private async snapshot(actorId: string, key: string, contactId: string) {
		const results = await this.database.batch<MemberRow | CommandRow | ContactRow>([
			this.database
				.prepare('SELECT status FROM instance_member WHERE user_id = ? LIMIT 1')
				.bind(actorId),
			this.database
				.prepare(
					'SELECT command_type, request_hash, contact_id, result_version, occurred_at FROM contact_command WHERE actor_id = ? AND idempotency_key = ? LIMIT 1'
				)
				.bind(actorId, key),
			this.database
				.prepare(`SELECT ${COLUMNS} FROM contact WHERE owner_user_id = ? AND id = ? LIMIT 1`)
				.bind(actorId, contactId)
		]);
		return {
			member: results[0]?.results[0] as MemberRow | undefined,
			receipt: results[1]?.results[0] as CommandRow | undefined,
			contact: results[2]?.results[0] as ContactRow | undefined
		};
	}

	private async read(ownerId: string, contactId: string): Promise<ContactRow | null> {
		return await this.database
			.prepare(`SELECT ${COLUMNS} FROM contact WHERE owner_user_id = ? AND id = ? LIMIT 1`)
			.bind(ownerId, contactId)
			.first<ContactRow>();
	}
}

function receiptMatches(
	receipt: CommandRow,
	command: CreateContactCommand | UpdateContactCommand | DeleteContactCommand,
	type: string
): boolean {
	return (
		receipt.command_type === type &&
		receipt.request_hash === command.requestFingerprint &&
		receipt.contact_id === command.contactId
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
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function metadata(
	command: CreateContactCommand,
	version: number,
	updatedAt: string
): ContactMetadata {
	return {
		id: command.contactId,
		name: command.name,
		email: command.email,
		locale: command.locale,
		version,
		createdAt: command.occurredAt,
		updatedAt
	};
}

function escapeLike(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function changes(result: D1Result): number {
	const value: unknown = (result.meta as { changes?: unknown }).changes;
	return typeof value === 'number' ? value : 0;
}
