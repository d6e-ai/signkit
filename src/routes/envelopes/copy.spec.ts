import { describe, expect, it } from 'vitest';

describe('envelope list product copy', () => {
	it('describes the product in plain end-user terms, never implementation architecture', async () => {
		const en = (await import('../../../messages/en.json')).default;
		const ja = (await import('../../../messages/ja.json')).default;

		for (const description of [en.envelope_list_description, ja.envelope_list_description]) {
			expect(description).not.toMatch(/envelope/i);
			expect(description).not.toMatch(/recipient graph/i);
			expect(description).not.toMatch(/git/i);
			expect(description).not.toMatch(/commit/i);
		}
	});

	it('keeps the meaning: an agreement and its signers stay together from drafting through signature', async () => {
		const en = (await import('../../../messages/en.json')).default;
		expect(en.envelope_list_description).toMatch(/agreement/i);
		expect(en.envelope_list_description).toMatch(/sign/i);
	});

	it('names the document revision in product language, not Git generation', async () => {
		const en = (await import('../../../messages/en.json')).default;
		const ja = (await import('../../../messages/ja.json')).default;

		expect(en.envelope_generation_label).toBe('Revision {generation}');
		expect(ja.envelope_generation_label).toBe('リビジョン {generation}');
		expect(en.envelope_documents_description).toMatch(/PDF.*Word/i);
		expect(ja.envelope_documents_description).toMatch(/PDF.*Word/);
		expect(en.envelope_documents_description).not.toMatch(/markdown/i);
		expect(ja.envelope_documents_description).not.toMatch(/Markdown/i);
		expect(en.envelope_documents_description).not.toMatch(/git/i);
		expect(en.envelope_documents_description).not.toMatch(/generation/i);
		expect(en.envelope_documents_description).not.toMatch(/commit/i);
		expect(ja.envelope_documents_description).not.toMatch(/Git|世代|コミット/);
		expect(en.envelope_import_docx_hint).not.toMatch(/git/i);
		expect(en.envelope_import_docx_hint).not.toMatch(/commit/i);
		expect(ja.envelope_import_docx_hint).not.toMatch(/Git|コミット/);
		expect(en.envelope_import_docx_hint).not.toMatch(/markdown/i);
		expect(ja.envelope_import_docx_hint).not.toMatch(/Markdown/i);

		for (const messages of [en, ja]) {
			for (const [key, value] of Object.entries(messages)) {
				if (typeof value !== 'string') continue;
				expect(`${key}:${value}`).not.toMatch(/Git世代|Git generation/i);
				expect(`${key}:${value}`).not.toMatch(/\bGit\b/);
			}
		}
	});

	it('labels recipient order and delivery in ordinary sender language', async () => {
		const en = (await import('../../../messages/en.json')).default;
		const ja = (await import('../../../messages/ja.json')).default;
		expect(en.envelope_recipient_col_order).toBe('Order');
		expect(ja.envelope_recipient_col_order).toBe('順番');
		expect(en.envelope_delivery_status_blocked).toMatch(/earlier recipients/i);
		expect(en.envelope_delivery_status_pending).toMatch(/waiting to send/i);
		expect(en.envelope_delivery_status_pending).not.toMatch(/^pending$/i);
		expect(en.envelope_delivery_status_processing).toBe('Sending');
		expect(en.envelope_delivery_status_delivered).toBe('Email sent');
		expect(en.envelope_delivery_status_failed).toBe('Could not send');
		expect(ja.envelope_delivery_status_pending).toBe('送信待ち');
		expect(ja.envelope_delivery_status_blocked).toBe('先の受信者の完了待ち');
		expect(ja.envelope_delivery_status_processing).toBe('送信中');
		expect(ja.envelope_delivery_status_delivered).toBe('メール送信済み');
		expect(ja.envelope_delivery_status_failed).toBe('送信できませんでした');
		expect(en.envelope_recipient_status_pending).toBe('Waiting');
		expect(en.envelope_recipient_status_pending).not.toBe('pending');
	});

	it('localizes explicit contact reuse without implying automatic retention', async () => {
		const en = (await import('../../../messages/en.json')).default;
		const ja = (await import('../../../messages/ja.json')).default;

		expect(en.contacts_save_recipient_action).toBe('Save to contacts');
		expect(ja.contacts_save_recipient_action).toBe('連絡先に保存');
		expect(en.contacts_manage_action).toBe('Manage contacts');
		expect(ja.contacts_manage_action).toBe('連絡先を管理');
		for (const copy of [
			en.contacts_manage_description,
			en.contacts_empty_description,
			ja.contacts_manage_description,
			ja.contacts_empty_description
		]) {
			expect(copy).not.toMatch(/automatic|automatically|自動/);
		}
	});

	it('never claims PAdES or legal certification for completed-agreement downloads', async () => {
		const en = (await import('../../../messages/en.json')).default;
		const ja = (await import('../../../messages/ja.json')).default;

		for (const [key, value] of [...Object.entries(en), ...Object.entries(ja)]) {
			if (!key.startsWith('envelope_completed_') && !key.startsWith('completion_receipt_')) {
				continue;
			}
			expect(`${key}:${value}`).not.toMatch(/PAdES/i);
			expect(`${key}:${value}`).not.toMatch(/legal(ly)? certif/i);
			expect(`${key}:${value}`).not.toMatch(/法的.{0,4}証明/);
			expect(`${key}:${value}`).not.toMatch(/認証局/);
		}
	});
});
