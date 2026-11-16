import {
	escapeHtml,
	TRANSACTIONAL_EMAIL_BACKGROUND,
	TRANSACTIONAL_EMAIL_BORDER,
	TRANSACTIONAL_EMAIL_CARD,
	TRANSACTIONAL_EMAIL_FOREGROUND,
	TRANSACTIONAL_EMAIL_MUTED_FOREGROUND,
	TRANSACTIONAL_EMAIL_PRIMARY,
	TRANSACTIONAL_EMAIL_PRIMARY_FOREGROUND,
	type TransactionalMailCopy
} from '$lib/application/mail/transactional-email';
import type { InstanceInvitationDeliveryLocale } from '$lib/security/instance-invitation-delivery-payload';

export function renderInstanceInvitationMail(
	locale: InstanceInvitationDeliveryLocale,
	role: 'owner' | 'admin' | 'member',
	acceptanceUrl: string,
	expiresAt: string
): TransactionalMailCopy {
	const isJapanese: boolean = locale === 'ja';
	const subject: string = isJapanese
		? 'SignKitへの招待が届いています'
		: 'You have been invited to SignKit';
	const heading: string = isJapanese ? 'SignKitへの招待' : 'You are invited to SignKit';
	const intro: string = isJapanese
		? 'SignKitインスタンスへの招待が届いています。'
		: 'You have been invited to join a SignKit instance.';
	const roleLabel: string = localizedRole(locale, role);
	const cta: string = isJapanese ? '招待を受ける' : 'Accept invitation';
	const expiry: string = isJapanese ? `有効期限: ${expiresAt}` : `Expires: ${expiresAt}`;
	const instructions: string = isJapanese
		? '下のリンクを開き、このメールが届いたアカウントでログインして参加してください。'
		: 'Open the link below and sign in with the account that received this email to join.';
	const footer: string = isJapanese
		? 'この招待はあなた専用です。心当たりがない場合は、このメールを無視してください。'
		: 'This invitation is unique to you. If you were not expecting this email, you can ignore it.';
	const text: string = [
		heading,
		'',
		intro,
		`${isJapanese ? '役割' : 'Role'}: ${roleLabel}`,
		instructions,
		'',
		expiry,
		'',
		acceptanceUrl,
		'',
		footer
	].join('\n');
	return {
		subject,
		text,
		html: renderHtml(locale, {
			heading,
			intro,
			roleLabel,
			cta,
			expiry,
			instructions,
			footer,
			acceptanceUrl
		})
	};
}

interface HtmlCopy {
	heading: string;
	intro: string;
	roleLabel: string;
	cta: string;
	expiry: string;
	instructions: string;
	footer: string;
	acceptanceUrl: string;
}

function renderHtml(locale: InstanceInvitationDeliveryLocale, copy: HtmlCopy): string {
	const safe = Object.fromEntries(
		Object.entries(copy).map(([key, value]: [string, string]): [string, string] => [
			key,
			escapeHtml(value)
		])
	) as unknown as HtmlCopy;
	return (
		'<!doctype html>' +
		`<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${safe.heading}</title></head>` +
		`<body style="margin:0;padding:0;background:${TRANSACTIONAL_EMAIL_BACKGROUND};color:${TRANSACTIONAL_EMAIL_FOREGROUND};font-family:Arial,Helvetica,sans-serif">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${TRANSACTIONAL_EMAIL_CARD};border:1px solid ${TRANSACTIONAL_EMAIL_BORDER};border-radius:10px">` +
		`<tr><td style="padding:28px 28px 12px;font-size:18px;font-weight:700;color:${TRANSACTIONAL_EMAIL_PRIMARY}">SignKit</td></tr>` +
		`<tr><td style="padding:8px 28px 0;font-size:22px;line-height:1.3;font-weight:700">${safe.heading}</td></tr>` +
		`<tr><td style="padding:16px 28px 0;font-size:16px;line-height:1.6">${safe.intro}</td></tr>` +
		`<tr><td style="padding:12px 28px 0;font-size:14px;line-height:1.6;color:${TRANSACTIONAL_EMAIL_MUTED_FOREGROUND}">${locale === 'ja' ? '役割' : 'Role'}: ${safe.roleLabel}</td></tr>` +
		`<tr><td style="padding:16px 28px 0;font-size:15px;line-height:1.6">${safe.instructions}</td></tr>` +
		`<tr><td style="padding:10px 28px 0;font-size:12px;color:${TRANSACTIONAL_EMAIL_MUTED_FOREGROUND}">${safe.expiry}</td></tr>` +
		`<tr><td align="center" style="padding:28px"><a href="${safe.acceptanceUrl}" style="display:inline-block;padding:12px 24px;background:${TRANSACTIONAL_EMAIL_PRIMARY};color:${TRANSACTIONAL_EMAIL_PRIMARY_FOREGROUND};text-decoration:none;border-radius:8px;font-size:16px;font-weight:700">${safe.cta}</a></td></tr>` +
		`<tr><td style="padding:20px 28px 28px;border-top:1px solid ${TRANSACTIONAL_EMAIL_BORDER};font-size:12px;line-height:1.5;color:${TRANSACTIONAL_EMAIL_MUTED_FOREGROUND}">${safe.footer}</td></tr>` +
		'</table></td></tr></table></body></html>'
	);
}

function localizedRole(
	locale: InstanceInvitationDeliveryLocale,
	role: 'owner' | 'admin' | 'member'
): string {
	if (locale === 'en')
		return role === 'owner' ? 'Owner' : role === 'admin' ? 'Administrator' : 'Member';
	return role === 'owner' ? '所有者' : role === 'admin' ? '管理者' : 'メンバー';
}
