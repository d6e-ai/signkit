import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach((): void => {
	vi.doUnmock('$lib/adapters/db/postgres-envelope-application-store');
	vi.resetModules();
});

describe('resolvePostgresSql', () => {
	it('rejects a missing DATABASE_URL', async () => {
		const { resolvePostgresSql } = await import('./postgres-sql-runtime');
		expect(() => resolvePostgresSql('')).toThrow('DATABASE_URL is required');
	});

	it('rejects a malformed DATABASE_URL', async () => {
		vi.resetModules();
		const { resolvePostgresSql } = await import('./postgres-sql-runtime');
		expect(() => resolvePostgresSql('not a url')).toThrow(
			'DATABASE_URL must be a valid PostgreSQL URL'
		);
	});

	it('rejects a non-PostgreSQL scheme', async () => {
		vi.resetModules();
		const { resolvePostgresSql } = await import('./postgres-sql-runtime');
		expect(() => resolvePostgresSql('mysql://localhost/db')).toThrow(
			'DATABASE_URL must use the postgres or postgresql scheme'
		);
	});

	it('reuses the same process-local pool for the same URL', async () => {
		vi.resetModules();
		const { resolvePostgresSql } = await import('./postgres-sql-runtime');
		const first = resolvePostgresSql('postgres://signkit:secret@localhost:5432/signkit');
		const second = resolvePostgresSql(' postgres://signkit:secret@localhost:5432/signkit ');
		expect(second).toBe(first);
	});

	it('throws instead of silently switching databases in a warm process', async () => {
		vi.resetModules();
		const { resolvePostgresSql } = await import('./postgres-sql-runtime');
		resolvePostgresSql('postgres://signkit:secret@localhost:5432/first');
		expect(() => resolvePostgresSql('postgres://signkit:secret@localhost:5432/second')).toThrow(
			'Database configuration changed after runtime initialization'
		);
	});

	it('never constructs the envelope application store graph just to resolve SQL', async () => {
		const storeConstructorSpy = vi.fn();
		vi.doMock('$lib/adapters/db/postgres-envelope-application-store', () => ({
			PostgresEnvelopeApplicationStore: class {
				constructor(...args: unknown[]) {
					storeConstructorSpy(...args);
				}
			}
		}));
		vi.resetModules();
		const { resolvePostgresSql } = await import('./postgres-sql-runtime');
		resolvePostgresSql('postgres://signkit:secret@localhost:5432/signkit');
		expect(storeConstructorSpy).not.toHaveBeenCalled();
	});
});
