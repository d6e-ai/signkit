import { describe, expect, it, vi } from 'vitest';
import { D1RecipientFieldDeclarationStore } from './d1-recipient-field-declaration-store';

describe('D1RecipientFieldDeclarationStore', () => {
	it('returns this recipient own fields with the envelope field generation', async () => {
		const first = vi.fn(async () => ({ field_generation: 3 }));
		const all = vi.fn(async () => ({
			results: [
				{
					id: 'field-1',
					document_id: null,
					document_path: 'documents/agreement.md',
					field_type: 'signature',
					label: 'Your signature',
					required: 1,
					position: 0,
					page: 2,
					x: 0.1,
					y: 0.2,
					width: 0.3,
					height: 0.05
				},
				{
					id: 'field-2',
					document_id: null,
					document_path: 'documents/agreement.md',
					field_type: 'date',
					label: 'Date',
					required: 0,
					position: 1,
					page: null,
					x: null,
					y: null,
					width: null,
					height: null
				}
			]
		}));
		const prepare = vi.fn((sql: string) => ({
			bind: (...bindings: unknown[]) => {
				expect(bindings[0]).toBe('env-1');
				return { first, all, sql };
			}
		}));
		const store = new D1RecipientFieldDeclarationStore({ prepare } as unknown as D1Database);
		await expect(store.listOwnFields('env-1', 'recipient-1')).resolves.toEqual({
			fieldGeneration: 3,
			fields: [
				{
					id: 'field-1',
					documentId: null,
					documentPath: 'documents/agreement.md',
					fieldType: 'signature',
					label: 'Your signature',
					required: true,
					position: 0,
					geometry: { page: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.05 }
				},
				{
					id: 'field-2',
					documentId: null,
					documentPath: 'documents/agreement.md',
					fieldType: 'date',
					label: 'Date',
					required: false,
					position: 1,
					// All-or-nothing: a row without a complete placement reports none.
					geometry: null
				}
			]
		});
		expect(prepare.mock.calls[0][0]).toContain('field_generation');
		expect(prepare.mock.calls[1][0]).toContain('recipient_id = ?');
		expect(prepare.mock.calls[1][0]).toContain('page, x, y, width, height');
	});

	it('returns null when the envelope pointer is missing', async () => {
		const prepare = vi.fn(() => ({
			bind: () => ({
				first: async () => null,
				all: async () => ({ results: [] })
			})
		}));
		const store = new D1RecipientFieldDeclarationStore({ prepare } as unknown as D1Database);
		await expect(store.listOwnFields('env-1', 'recipient-1')).resolves.toBeNull();
	});
});
