import { describe, expect, it } from 'vitest';
import {
	TRANSACTIONAL_EMAIL_BACKGROUND,
	TRANSACTIONAL_EMAIL_BORDER,
	TRANSACTIONAL_EMAIL_CARD,
	TRANSACTIONAL_EMAIL_MUTED,
	TRANSACTIONAL_EMAIL_PRIMARY,
	escapeHtml,
	renderCompletionMail,
	renderInvitationMail
} from './transactional-email';

const SIGNING_URL: string = 'https://signkit.example/s/opaque-token';
const COMPLETION_URL: string = 'https://signkit.example/c/opaque-token';

function assertRichTemplate(html: string, locale: 'en' | 'ja'): void {
	expect(html).toContain('<!doctype html>');
	expect(html).toContain(`lang="${locale}"`);
	expect(html).toContain('role="presentation"');
	expect(html).toContain('max-width:600px');
	expect(html).toContain(`background-color:${TRANSACTIONAL_EMAIL_BACKGROUND}`);
	expect(html).toContain(`background-color:${TRANSACTIONAL_EMAIL_CARD}`);
	expect(html).toContain(`border:1px solid ${TRANSACTIONAL_EMAIL_BORDER}`);
	expect(html).toContain(`background-color:${TRANSACTIONAL_EMAIL_MUTED}`);
	expect(html).toContain(`background-color:${TRANSACTIONAL_EMAIL_PRIMARY}`);
	expect(html).toContain(`color:${TRANSACTIONAL_EMAIL_PRIMARY}`);
	expect(html).toContain('SignKit');
	expect(html).not.toMatch(/<script[\s>]/i);
	expect(html).not.toMatch(/javascript:/i);
	expect(html).not.toContain('<img');
	expect(html).not.toMatch(/fonts\.google/i);
	expect(html).not.toMatch(/@font-face/i);
	expect(html).not.toMatch(/\bsrc="https?:\/\//i);
	expect(html).not.toMatch(/http-equiv="refresh"/i);
}

describe('transactional invitation mail', () => {
	it('renders English copy from the stored locale and never from the mailbox', () => {
		const copy = renderInvitationMail('en', 'Taro', 'Service Agreement', SIGNING_URL);
		expect(copy.subject).toBe('Please review "Service Agreement"');
		expect(copy.text).toContain('Hello Taro,');
		expect(copy.text).toContain('You have been invited to review "Service Agreement".');
		expect(copy.text).toContain(SIGNING_URL);
		expect(copy.text).not.toContain('<html');
		expect(copy.html).toContain('Open the agreement');
		expect(copy.html).toContain(`href="${SIGNING_URL}"`);
		expect(copy.html).toContain(SIGNING_URL);
		expect(copy.html).not.toContain('契約書を開く');
		assertRichTemplate(copy.html, 'en');
	});

	it('uses the exact Japanese invitation CTA and 契約書 terminology', () => {
		const copy = renderInvitationMail('ja', '佐藤', '業務委託契約', SIGNING_URL);
		expect(copy.subject).toBe('「業務委託契約」の確認をお願いします');
		expect(copy.text).toContain('佐藤 様');
		expect(copy.text).toContain('「業務委託契約」の確認依頼が届いています。');
		expect(copy.text).toContain(SIGNING_URL);
		expect(copy.html).toContain('>契約書を開く<');
		expect(copy.html).toContain('契約書');
		expect(copy.html).not.toContain('合意書');
		expect(copy.text).not.toContain('合意書');
		expect(copy.html).not.toContain('合意書を開く');
		assertRichTemplate(copy.html, 'ja');
	});

	it('does not infer locale from a Japanese-looking mailbox', () => {
		const copy = renderInvitationMail('en', 'Alex', 'NDA', SIGNING_URL);
		expect(copy.html).toContain('lang="en"');
		expect(copy.html).toContain('Open the agreement');
		expect(copy.html).not.toContain('契約書を開く');
	});
});

describe('transactional completion mail', () => {
	it('renders English completion copy with the shared template', () => {
		const copy = renderCompletionMail('en', 'Morgan', 'Partnership Agreement', COMPLETION_URL);
		expect(copy.subject).toBe('Completed: "Partnership Agreement"');
		expect(copy.text).toContain('Hello Morgan,');
		expect(copy.text).toContain('"Partnership Agreement" has been completed by all participants.');
		expect(copy.text).toContain(COMPLETION_URL);
		expect(copy.html).toContain('View completed documents');
		assertRichTemplate(copy.html, 'en');
	});

	it('replaces Japanese 合意書 terminology with 契約書', () => {
		const copy = renderCompletionMail('ja', '佐藤', '業務委託契約', COMPLETION_URL);
		expect(copy.subject).toBe('「業務委託契約」の手続きが完了しました');
		expect(copy.text).toContain(
			'次のリンクを開いて完了した契約書を確認またはダウンロードしてください。'
		);
		expect(copy.html).toContain('>完了した契約書を開く<');
		expect(copy.html).not.toContain('合意書');
		expect(copy.text).not.toContain('合意書');
		assertRichTemplate(copy.html, 'ja');
	});

	it('defaults to fallback (not-attached) English copy when no attachment status is given', () => {
		const copy = renderCompletionMail('en', 'Morgan', 'Partnership Agreement', COMPLETION_URL);
		expect(copy.text).toContain(
			'Due to its file size, the completed PDF is not attached to this email.'
		);
		expect(copy.html).toContain(
			'Due to its file size, the completed PDF is not attached to this email.'
		);
	});

	it('renders attached English copy confirming the PDF is included', () => {
		const copy = renderCompletionMail(
			'en',
			'Morgan',
			'Partnership Agreement',
			COMPLETION_URL,
			'attached'
		);
		expect(copy.text).toContain('The completed PDF is attached to this email for your records.');
		expect(copy.html).toContain('The completed PDF is attached to this email for your records.');
		expect(copy.text).not.toContain('is not attached to this email');
	});

	it('renders attached and fallback Japanese copy without 合意書 terminology', () => {
		const attached = renderCompletionMail('ja', '佐藤', '業務委託契約', COMPLETION_URL, 'attached');
		expect(attached.text).toContain('完了した契約書のPDFをこのメールに添付しております。');
		expect(attached.html).toContain('完了した契約書のPDFをこのメールに添付しております。');
		expect(attached.text).not.toContain('合意書');

		const fallback = renderCompletionMail(
			'ja',
			'佐藤',
			'業務委託契約',
			COMPLETION_URL,
			'not_attached'
		);
		expect(fallback.text).toContain(
			'ファイルサイズの都合により、完了した契約書のPDFは本メールに添付されておりません。'
		);
		expect(fallback.text).not.toContain('合意書');
	});
});

describe('transactional mail escaping', () => {
	it('HTML-escapes names, titles, and URLs and does not inject markup', () => {
		const name: string = `Alice <script>alert("xss")</script> & O'Connor`;
		const title: string = `NDA "Special" & <Offer> 2026`;
		const url: string = `https://signkit.example/s/tok" onclick="alert(1)`;
		const copy = renderInvitationMail('en', name, title, url);
		expect(copy.text).toContain(name);
		expect(copy.text).toContain(title);
		expect(copy.text).toContain(url);
		expect(copy.html).toContain(escapeHtml(name));
		expect(copy.html).toContain(escapeHtml(title));
		expect(copy.html).toContain(`href="${escapeHtml(url)}"`);
		expect(copy.html).not.toContain('<script>');
		expect(copy.html).not.toContain('onclick="alert(1)"');
		expect(copy.html).not.toContain(`<img`);
	});
});
