export type TransactionalMailLocale = 'en' | 'ja';

export interface TransactionalMailCopy {
	subject: string;
	text: string;
	html: string;
}

/** SignKit Luma primary. Hex so email clients do not need CSS color functions. */
export const TRANSACTIONAL_EMAIL_PRIMARY: string = '#ca3500';
export const TRANSACTIONAL_EMAIL_PRIMARY_FOREGROUND: string = '#fff8f0';
export const TRANSACTIONAL_EMAIL_BACKGROUND: string = '#f6f7f8';
export const TRANSACTIONAL_EMAIL_CARD: string = '#ffffff';
export const TRANSACTIONAL_EMAIL_FOREGROUND: string = '#1c2128';
export const TRANSACTIONAL_EMAIL_BORDER: string = '#e6e9eb';
export const TRANSACTIONAL_EMAIL_MUTED: string = '#f1f3f4';
export const TRANSACTIONAL_EMAIL_MUTED_FOREGROUND: string = '#5c6670';

const FONT_STACK: string = 'Arial, Helvetica, sans-serif';
const WORDMARK: string = 'SignKit';
const JAPANESE_INVITATION_CTA: string = '契約書を開く';

interface LocalizedMailContent {
	locale: TransactionalMailLocale;
	subject: string;
	heading: string;
	greeting: string;
	intro: string;
	documentLabel: string;
	ctaLabel: string;
	fallbackIntro: string;
	footer: string;
	textLines: readonly string[];
}

export function renderInvitationMail(
	locale: TransactionalMailLocale,
	name: string,
	title: string,
	signingUrl: string
): TransactionalMailCopy {
	return renderMail(invitationContent(locale, name, title), title, signingUrl);
}

export function renderCompletionMail(
	locale: TransactionalMailLocale,
	name: string,
	title: string,
	completionUrl: string
): TransactionalMailCopy {
	return renderMail(completionContent(locale, name, title), title, completionUrl);
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function invitationContent(
	locale: TransactionalMailLocale,
	name: string,
	title: string
): LocalizedMailContent {
	if (locale === 'ja') {
		return {
			locale,
			subject: `「${title}」の確認をお願いします`,
			heading: '契約書の確認をお願いします',
			greeting: `${name} 様`,
			intro: '次の契約書の確認依頼が届いています。',
			documentLabel: '契約書',
			ctaLabel: JAPANESE_INVITATION_CTA,
			fallbackIntro: 'ボタンが開かない場合は、次のURLをブラウザーにコピーして開いてください。',
			footer: 'このリンクはあなた専用です。心当たりがない場合は、このメールを無視してください。',
			textLines: [
				`${name} 様`,
				'',
				`「${title}」の確認依頼が届いています。`,
				'',
				'次のリンクを開いて手続きを続けてください。',
				''
			]
		};
	}
	return {
		locale,
		subject: `Please review "${title}"`,
		heading: 'Please review this agreement',
		greeting: `Hello ${name},`,
		intro: 'You have been invited to review the following agreement.',
		documentLabel: 'Agreement',
		ctaLabel: 'Open the agreement',
		fallbackIntro: 'If the button does not work, copy and paste this URL into your browser:',
		footer: 'This link is unique to you. If you were not expecting this email, you can ignore it.',
		textLines: [
			`Hello ${name},`,
			'',
			`You have been invited to review "${title}".`,
			'',
			'Open this link to continue:',
			''
		]
	};
}

function completionContent(
	locale: TransactionalMailLocale,
	name: string,
	title: string
): LocalizedMailContent {
	if (locale === 'ja') {
		return {
			locale,
			subject: `「${title}」の手続きが完了しました`,
			heading: '契約書の手続きが完了しました',
			greeting: `${name} 様`,
			intro: 'すべての参加者が次の契約書の手続きを完了しました。',
			documentLabel: '契約書',
			ctaLabel: '完了した契約書を開く',
			fallbackIntro: 'ボタンが開かない場合は、次のURLをブラウザーにコピーして開いてください。',
			footer: 'このリンクはあなた専用です。心当たりがない場合は、このメールを無視してください。',
			textLines: [
				`${name} 様`,
				'',
				`「${title}」の手続きが完了しました。`,
				'',
				'次のリンクを開いて完了した契約書を確認またはダウンロードしてください。',
				''
			]
		};
	}
	return {
		locale,
		subject: `Completed: "${title}"`,
		heading: 'Agreement completed',
		greeting: `Hello ${name},`,
		intro: 'All participants have completed the following agreement.',
		documentLabel: 'Agreement',
		ctaLabel: 'View completed documents',
		fallbackIntro: 'If the button does not work, copy and paste this URL into your browser:',
		footer: 'This link is unique to you. If you were not expecting this email, you can ignore it.',
		textLines: [
			`Hello ${name},`,
			'',
			`"${title}" has been completed by all participants.`,
			'',
			'Open this link to view or download the completed documents:',
			''
		]
	};
}

function renderMail(
	content: LocalizedMailContent,
	title: string,
	url: string
): TransactionalMailCopy {
	return {
		subject: content.subject,
		text: [...content.textLines, url, '', content.footer].join('\n'),
		html: renderHtmlDocument(content, title, url)
	};
}

function renderHtmlDocument(content: LocalizedMailContent, title: string, url: string): string {
	const heading: string = escapeHtml(content.heading);
	const greeting: string = escapeHtml(content.greeting);
	const intro: string = escapeHtml(content.intro);
	const documentLabel: string = escapeHtml(content.documentLabel);
	const safeTitle: string = escapeHtml(title);
	const ctaLabel: string = escapeHtml(content.ctaLabel);
	const safeUrl: string = escapeHtml(url);
	const fallbackIntro: string = escapeHtml(content.fallbackIntro);
	const footer: string = escapeHtml(content.footer);
	const preheader: string = escapeHtml(`${content.intro} ${title}`);
	const wordmark: string = escapeHtml(WORDMARK);

	return (
		'<!doctype html>' +
		`<html lang="${content.locale}">` +
		'<head>' +
		'<meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
		'<meta http-equiv="X-UA-Compatible" content="IE=edge">' +
		`<title>${heading}</title>` +
		'</head>' +
		`<body style="margin:0;padding:0;background-color:${TRANSACTIONAL_EMAIL_BACKGROUND};color:${TRANSACTIONAL_EMAIL_FOREGROUND};font-family:${FONT_STACK};">` +
		`<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${TRANSACTIONAL_EMAIL_BACKGROUND};">${preheader}</div>` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${TRANSACTIONAL_EMAIL_BACKGROUND};">` +
		'<tr>' +
		`<td align="center" style="padding:24px 16px;">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:${TRANSACTIONAL_EMAIL_CARD};border:1px solid ${TRANSACTIONAL_EMAIL_BORDER};border-radius:10px;">` +
		'<tr>' +
		`<td style="padding:28px 28px 12px;font-family:${FONT_STACK};font-size:18px;line-height:1.2;font-weight:700;letter-spacing:0.04em;color:${TRANSACTIONAL_EMAIL_PRIMARY};">${wordmark}</td>` +
		'</tr>' +
		'<tr>' +
		`<td style="padding:8px 28px 0;font-family:${FONT_STACK};font-size:22px;line-height:1.3;font-weight:700;color:${TRANSACTIONAL_EMAIL_FOREGROUND};">${heading}</td>` +
		'</tr>' +
		'<tr>' +
		`<td style="padding:16px 28px 0;font-family:${FONT_STACK};font-size:16px;line-height:1.6;color:${TRANSACTIONAL_EMAIL_FOREGROUND};">${greeting}</td>` +
		'</tr>' +
		'<tr>' +
		`<td style="padding:12px 28px 0;font-family:${FONT_STACK};font-size:16px;line-height:1.6;color:${TRANSACTIONAL_EMAIL_FOREGROUND};">${intro}</td>` +
		'</tr>' +
		'<tr>' +
		'<td style="padding:20px 28px 0;">' +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${TRANSACTIONAL_EMAIL_MUTED};border:1px solid ${TRANSACTIONAL_EMAIL_BORDER};border-radius:8px;">` +
		'<tr>' +
		`<td style="padding:14px 16px;font-family:${FONT_STACK};">` +
		`<div style="font-size:12px;line-height:1.4;letter-spacing:0.04em;text-transform:uppercase;color:${TRANSACTIONAL_EMAIL_MUTED_FOREGROUND};">${documentLabel}</div>` +
		`<div style="padding-top:6px;font-size:16px;line-height:1.5;font-weight:600;color:${TRANSACTIONAL_EMAIL_FOREGROUND};">${safeTitle}</div>` +
		'</td>' +
		'</tr>' +
		'</table>' +
		'</td>' +
		'</tr>' +
		'<tr>' +
		`<td align="center" style="padding:28px 28px 8px;">` +
		'<table role="presentation" cellpadding="0" cellspacing="0" border="0">' +
		'<tr>' +
		`<td align="center" bgcolor="${TRANSACTIONAL_EMAIL_PRIMARY}" style="background-color:${TRANSACTIONAL_EMAIL_PRIMARY};border-radius:8px;">` +
		`<a href="${safeUrl}" style="display:inline-block;padding:12px 24px;font-family:${FONT_STACK};font-size:16px;line-height:1.2;font-weight:700;color:${TRANSACTIONAL_EMAIL_PRIMARY_FOREGROUND};text-decoration:none;border-radius:8px;">${ctaLabel}</a>` +
		'</td>' +
		'</tr>' +
		'</table>' +
		'</td>' +
		'</tr>' +
		'<tr>' +
		`<td style="padding:12px 28px 0;font-family:${FONT_STACK};font-size:13px;line-height:1.5;color:${TRANSACTIONAL_EMAIL_MUTED_FOREGROUND};">${fallbackIntro}<br><a href="${safeUrl}" style="color:${TRANSACTIONAL_EMAIL_PRIMARY};text-decoration:underline;word-break:break-all;">${safeUrl}</a></td>` +
		'</tr>' +
		'<tr>' +
		`<td style="padding:28px 28px 32px;font-family:${FONT_STACK};font-size:12px;line-height:1.5;color:${TRANSACTIONAL_EMAIL_MUTED_FOREGROUND};border-top:1px solid ${TRANSACTIONAL_EMAIL_BORDER};">${footer}</td>` +
		'</tr>' +
		'</table>' +
		'</td>' +
		'</tr>' +
		'</table>' +
		'</body>' +
		'</html>'
	);
}
