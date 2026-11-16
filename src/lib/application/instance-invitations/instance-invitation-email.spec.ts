import { expect, it } from 'vitest';
import { renderInstanceInvitationMail } from './instance-invitation-email';

it.each(['en', 'ja'] as const)(
	'uses an acceptance link without a manual token instruction in %s mail',
	(locale) => {
		const token = `ski1_${'a'.repeat(43)}`;
		const link = `https://signkit.example/${locale}/invitations/accept#token=${token}`;
		const mail = renderInstanceInvitationMail(locale, 'member', link, '2026-12-01T00:00:00Z');
		expect(mail.text).toContain(link);
		expect(mail.html).toContain(`href="${link}"`);
		expect(mail.html).toContain(locale === 'ja' ? '招待を受ける' : 'Accept invitation');
		expect(mail.text).not.toMatch(/paste|貼り付け/);
		expect(mail.html).not.toMatch(/One-time invitation token|ワンタイム招待トークン/);
	}
);
