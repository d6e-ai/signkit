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

export interface WorkerMailEnv extends SmtpConfigEnv {
	SIGNKIT_MAIL_PROVIDER?: string;
}

/**
 * Selects the Cloudflare Workers mail transport. Nodemailer 10 supports its
 * SMTP transport on Workers under `nodejs_compat`, so the same adapter and
 * strict TLS configuration used by Node can be reused here. Workers prohibit
 * outbound SMTP on port 25, which is rejected before a transporter is built.
 * Missing or malformed configuration fails closed rather than falling back to
 * another provider.
 */
export async function resolveWorkerMailSender(
	workerEnv: WorkerMailEnv,
	email: SendEmail | undefined
): Promise<MailSender | null> {
	const provider: MailProvider | null = parseMailProvider(workerEnv.SIGNKIT_MAIL_PROVIDER);
	if (provider === 'cloudflare') {
		return email === undefined ? null : new CloudflareBindingMailSender(email);
	}
	if (provider === 'smtp') {
		const config = parseSmtpConfig(workerEnv);
		if (config === null || config.port === 25) return null;
		try {
			const { NodemailerSmtpMailSender } = await import('$lib/adapters/mail/smtp');
			return new NodemailerSmtpMailSender(config);
		} catch {
			return null;
		}
	}
	return null;
}

export interface NodeMailEnv extends SmtpConfigEnv {
	[key: string]: string | undefined;
	SIGNKIT_MAIL_PROVIDER?: string;
	CLOUDFLARE_EMAIL_ACCOUNT_ID?: string;
	CLOUDFLARE_EMAIL_API_TOKEN?: string;
}

/**
 * Selects the Node/Docker and Vercel mail transport. `cloudflare` reuses the
 * existing REST sender (Cloudflare Email Sending has no Workers-only API);
 * `smtp` covers every other provider, including Resend, through its plain
 * SMTP endpoint — there is no provider-specific code path here on purpose.
 * The Nodemailer adapter is imported dynamically so a process selecting the
 * Cloudflare REST provider does not initialize SMTP or its TCP/TLS path.
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
