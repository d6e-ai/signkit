import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1_RECIPIENT_ACCESS_QUERY } from './d1-recipient-access-store';

const now: string = '2026-09-11T00:00:00.000Z';

function database(): DatabaseSync {
	const db: DatabaseSync = new DatabaseSync(':memory:');
	db.exec(readFileSync('migrations/d1/0001_core.sql', 'utf8'));
	db.exec(readFileSync('migrations/d1/0004_envelope_ready.sql', 'utf8'));
	db.exec(`
		INSERT INTO organization (id,d6e_organization_id,name,created_at)
		VALUES ('org-1','org-1','One','${now}'), ('org-2','org-2','Two','${now}');
		INSERT INTO envelope (id,organization_id,title,status,created_at,updated_at)
		VALUES ('shared','org-1','Correct','sent','${now}','${now}'),
			('shared','org-2','Wrong tenant','completed','${now}','${now}');
		INSERT INTO recipient (id,organization_id,envelope_id,email,name,role,locale,routing_order,status,
			capability_hash,capability_expires_at,created_at,updated_at)
		VALUES ('recipient-1','org-1','shared','recipient@example.com','Recipient','signer','en',1,'pending',
			'hash-1','2026-09-12T00:00:00.000Z','${now}','${now}');
	`);
	return db;
}

function resolve(db: DatabaseSync): unknown {
	return db.prepare(D1_RECIPIENT_ACCESS_QUERY).get('hash-1', now);
}

describe('D1 recipient access query', () => {
	it('resolves the active tenant-scoped recipient', () => {
		const db: DatabaseSync = database();
		try {
			expect(resolve(db)).toMatchObject({
				organization_id: 'org-1',
				envelope_id: 'shared',
				envelope_title: 'Correct'
			});
		} finally {
			db.close();
		}
	});

	it.each([
		['blocked null expiry', 'capability_expires_at=NULL'],
		['expiry boundary', `capability_expires_at='${now}'`],
		['expired', "capability_expires_at='2026-09-10T00:00:00.000Z'"],
		['invalid expiry', "capability_expires_at='not-a-timestamp'"],
		['revoked', `capability_revoked_at='${now}'`],
		['completed recipient', "status='completed'"],
		['declined recipient', "status='declined'"],
		['CC recipient', "role='cc'"]
	])('fails closed for %s', (_name, assignment) => {
		const db: DatabaseSync = database();
		try {
			db.exec(
				`UPDATE recipient SET ${assignment} WHERE organization_id='org-1' AND id='recipient-1'`
			);
			expect(resolve(db)).toBeUndefined();
		} finally {
			db.close();
		}
	});

	it.each(['ready', 'completed', 'declined', 'expired', 'voided'])(
		'fails closed for a %s envelope',
		(status) => {
			const db: DatabaseSync = database();
			try {
				db.exec(
					`UPDATE envelope SET status='${status}' WHERE organization_id='org-1' AND id='shared'`
				);
				expect(resolve(db)).toBeUndefined();
			} finally {
				db.close();
			}
		}
	);

	it('does not join a recipient to the same envelope ID in another tenant', () => {
		const db: DatabaseSync = database();
		try {
			db.exec("UPDATE envelope SET status='completed' WHERE organization_id='org-1'");
			db.exec("UPDATE envelope SET status='sent' WHERE organization_id='org-2'");
			expect(resolve(db)).toBeUndefined();
		} finally {
			db.close();
		}
	});
});
