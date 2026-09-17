import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationSql: string = readdirSync('migrations/postgres')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => readFileSync(`migrations/postgres/${name}`, 'utf8'))
	.join('\n');

describe('PostgreSQL single-instance schema', () => {
	it('has no legacy multi-tenant tables, columns, or grants', () => {
		expect(migrationSql).not.toMatch(/\borganization(?:_id)?\b/i);
		expect(migrationSql).not.toContain('api_key_organization_grant');
	});

	it('requires every envelope creator to be an instance member', () => {
		expect(migrationSql).toMatch(
			/created_by_user_id\s+TEXT\s+NOT NULL\s+REFERENCES\s+instance_member\s*\(user_id\)/i
		);
	});

	it('uses the organization-free audit hash version', () => {
		expect(migrationSql).toMatch(/hash_version\s+INTEGER\s+NOT NULL\s+DEFAULT\s+3/i);
	});

	it('indexes the committed accepted-invitation concurrency lookup', () => {
		expect(migrationSql).toMatch(
			/CREATE UNIQUE INDEX instance_invitation_accepted_by_user\s+ON instance_invitation\(accepted_by_user_id\)\s+WHERE status = 'accepted'/i
		);
	});
});
