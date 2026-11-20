import { expect, it } from 'vitest';
import { renderInstanceInvitationMail } from './instance-invitation-email';

it.each(['en', 'ja'] as const)(
	'uses an acceptance link without a manual token instruction in %s mail',
	(locale) => {
		const token = `ski1_${'a'.repeat(43)}`;
		const link = `https://signkit.example/${locale}/invitations/accept#token=${token}`;
		const joinUrl = `https://signkit.example/${locale}/settings`;
		const mail = renderInstanceInvitationMail(
			locale,
			'member',
			link,
			'2026-12-01T00:00:00Z',
			joinUrl
		);
		expect(mail.text).toContain(link);
		expect(mail.html).toContain(`href="${link}"`);
		expect(mail.html).toContain(locale === 'ja' ? '招待を受ける' : 'Accept invitation');
		expect(mail.text).not.toMatch(/paste|貼り付け/);
		expect(mail.html).not.toMatch(/One-time invitation token|ワンタイム招待トークン/);
	}
);

it.each(['en', 'ja'] as const)(
	'tells %s invitees they can sign up with the address and join without the link',
	(locale) => {
		const token = `ski1_${'a'.repeat(43)}`;
		const link = `https://signkit.example/${locale}/invitations/accept#token=${token}`;
		const joinUrl = 'https://console.example/signkit/console?a=1&b=2';
		const mail = renderInstanceInvitationMail(
			locale,
			'admin',
			link,
			'2026-12-01T00:00:00Z',
			joinUrl
		);
		expect(mail.text).toContain(joinUrl);
		expect(mail.html).toContain('href="https://console.example/signkit/console?a=1&amp;b=2"');
		expect(mail.text).toMatch(
			locale === 'ja'
				? /アカウントを作成し、メールアドレスを確認すると参加できます/
				: /create one with this email address and verify it/
		);
		expect(mail.text).toMatch(locale === 'ja' ? /リンクを開かなくても/ : /without the link/);
		// The join URL never carries the one-time token.
		const joinLine = mail.text.split('\n').find((line) => line.startsWith('https://console.'));
		expect(joinLine).toBe(joinUrl);
	}
);
