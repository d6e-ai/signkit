import {
	CloudflareBindingMailSender,
	CloudflareRestMailSender
} from '$lib/adapters/mail/cloudflare-email';
import { parseSmtpConfig, type SmtpConfigEnv } from '$lib/adapters/mail/smtp-config';
import type { MailSender } from '$lib/ports/mail-sender';

export type MailProvider = 'smtp' | 'cloudflare';

export function parseMailProvider(value: string | undefined): MailProvider | null {
	const normalized: string | undefined = value?.trim().toLowerCase();
	return normalized === 'smtp' || normalized === 'cloudflare' ? normalized : null;
}

export interface WorkerMailEnv {
	SIGNKIT_MAIL_PROVIDER?: string;
}

/**
 * SignKit intentionally supports only the native EMAIL binding on Cloudflare
 * Workers and does not bundle or support a Worker SMTP client, so `smtp` is
 * never valid here regardless of what the runtime itself can otherwise do.
 * An `smtp` selection, a missing/invalid provider, or a missing binding all
 * fail closed to `null` rather than silently falling back to another
 * transport.
 */
export function resolveWorkerMailSender(
	workerEnv: WorkerMailEnv,
	email: SendEmail | undefined
): MailSender | null {
	if (parseMailProvider(workerEnv.SIGNKIT_MAIL_PROVIDER) !== 'cloudflare') return null;
	return email === undefined ? null : new CloudflareBindingMailSender(email);
}

export interface NodeMailEnv extends SmtpConfigEnv {
	SIGNKIT_MAIL_PROVIDER?: string;
	CLOUDFLARE_EMAIL_ACCOUNT_ID?: string;
	CLOUDFLARE_EMAIL_API_TOKEN?: string;
}

/**
 * Selects the Node/Docker and Vercel mail transport. `cloudflare` reuses the
 * existing REST sender (Cloudflare Email Sending has no Workers-only API);
 * `smtp` covers every other provider, including Resend, through its plain
 * SMTP endpoint — there is no provider-specific code path here on purpose.
 * The Nodemailer adapter is imported dynamically so it, and its native
 * TCP/TLS dependencies, are never pulled into the Cloudflare Workers bundle
 * that also links this module for `resolveWorkerMailSender`.
 */
export async function resolveNodeMailSender(env: NodeMailEnv): Promise<MailSender | null> {
	const provider: MailProvider | null = parseMailProvider(env.SIGNKIT_MAIL_PROVIDER);
	if (provider === 'smtp') {
		const config = parseSmtpConfig(env);
		if (config === null) return null;
		const { NodemailerSmtpMailSender } = await import('$lib/adapters/mail/smtp');
		return new NodemailerSmtpMailSender(config);
	}
	if (provider === 'cloudflare') {
		const accountId: string | undefined = nonempty(env.CLOUDFLARE_EMAIL_ACCOUNT_ID);
		const apiToken: string | undefined = nonempty(env.CLOUDFLARE_EMAIL_API_TOKEN);
		if (accountId === undefined || apiToken === undefined) return null;
		try {
			return new CloudflareRestMailSender(accountId, apiToken);
		} catch {
			return null;
		}
	}
	return null;
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
