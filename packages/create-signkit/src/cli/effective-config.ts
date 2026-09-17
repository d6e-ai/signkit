import {
	DEFAULT_D1_NAME,
	DEFAULT_D6E_AUTH_BASE_URL,
	DEFAULT_EMAIL_FROM_NAME,
	DEFAULT_R2_NAME,
	DEFAULT_WORKER_NAME
} from '../constants.js';
import { usage } from './errors.js';
import type { MailProviderId, ParsedCommand } from './parse.js';
import { hostnameFromOrigin, originFromDomain } from './urls.js';
import type { DeploymentState } from '../state/store.js';

export interface EffectiveTarget {
	accountId: string;
	workerName: string;
	d1: string;
	r2: string;
	domain?: string;
	publicOrigin?: string;
	d6eAuthBaseUrl: string;
	emailFrom?: string;
	emailFromName: string;
	mailProvider: MailProviderId;
	smtpHost?: string;
	smtpPort?: number;
	smtpSecure?: boolean;
	smtpUsername?: string;
	bootstrapOwnerEmail?: string;
	inherited: {
		workerName: boolean;
		d1: boolean;
		r2: boolean;
		domain: boolean;
		publicOrigin: boolean;
		d6eAuthBaseUrl: boolean;
		emailFrom: boolean;
		emailFromName: boolean;
		mailProvider: boolean;
		smtpHost: boolean;
		smtpPort: boolean;
		smtpSecure: boolean;
		smtpUsername: boolean;
		bootstrapOwnerEmail: boolean;
	};
	appliedDefaults: {
		d6eAuthBaseUrl: boolean;
		emailFromName: boolean;
	};
}

export function resolveEffectiveConfig(
	parsed: ParsedCommand,
	state: DeploymentState | undefined
): EffectiveTarget {
	const workerName = parsed.overrides.workerName
		? parsed.workerName
		: (state?.workerName ?? parsed.workerName ?? DEFAULT_WORKER_NAME);
	const d1 = parsed.overrides.d1 ? parsed.d1 : (state?.d1.name ?? parsed.d1 ?? DEFAULT_D1_NAME);
	const r2 = parsed.overrides.r2 ? parsed.r2 : (state?.r2.name ?? parsed.r2 ?? DEFAULT_R2_NAME);
	const domain = (
		parsed.overrides.domain ? parsed.domain : (state?.domain ?? parsed.domain)
	)?.toLowerCase();
	const publicOrigin = resolvePublicOrigin(parsed, state, domain);

	let d6eAuthBaseUrl = DEFAULT_D6E_AUTH_BASE_URL;
	let d6eAuthBaseUrlDefaulted = true;
	if (parsed.overrides.d6eAuthBaseUrl && parsed.d6eAuthBaseUrl) {
		d6eAuthBaseUrl = parsed.d6eAuthBaseUrl;
		d6eAuthBaseUrlDefaulted = false;
	} else if (state?.d6eAuthBaseUrl) {
		d6eAuthBaseUrl = state.d6eAuthBaseUrl;
		d6eAuthBaseUrlDefaulted = false;
	}

	const emailFrom = parsed.overrides.emailFrom
		? parsed.emailFrom
		: (parsed.emailFrom ?? state?.emailFrom);
	const mailProvider: MailProviderId = parsed.overrides.mailProvider
		? parsed.mailProvider
		: (state?.mailProvider ?? parsed.mailProvider ?? 'cloudflare');
	const smtpHost = parsed.overrides.smtpHost
		? parsed.smtpHost
		: (parsed.smtpHost ?? state?.smtpHost);
	const smtpPort = parsed.overrides.smtpPort
		? parsed.smtpPort
		: (parsed.smtpPort ?? state?.smtpPort);
	const smtpSecure = parsed.overrides.smtpSecure
		? parsed.smtpSecure
		: (parsed.smtpSecure ?? state?.smtpSecure);
	const smtpUsername = parsed.overrides.smtpUsername
		? parsed.smtpUsername
		: (parsed.smtpUsername ?? state?.smtpUsername);
	if (
		mailProvider === 'cloudflare' &&
		(parsed.overrides.smtpHost ||
			parsed.overrides.smtpPort ||
			parsed.overrides.smtpSecure ||
			parsed.overrides.smtpUsername)
	) {
		throw usage('SMTP flags require an effective --mail-provider smtp selection');
	}
	if (
		mailProvider === 'smtp' &&
		(smtpHost === undefined || smtpPort === undefined || smtpSecure === undefined)
	) {
		throw usage(
			'--mail-provider smtp requires --smtp-host, --smtp-port, and --smtp-secure (or inherited state values)'
		);
	}

	// Non-secret bootstrap owner: an explicit flag always wins so a typo can
	// be corrected before the claim; otherwise the recorded state value is
	// reused, preserving update compatibility for existing deployments.
	const bootstrapOwnerEmail = parsed.overrides.bootstrapOwnerEmail
		? parsed.bootstrapOwnerEmail
		: (parsed.bootstrapOwnerEmail ?? state?.bootstrapOwnerEmail);

	let emailFromName = DEFAULT_EMAIL_FROM_NAME;
	let emailFromNameDefaulted = true;
	if (parsed.overrides.emailFromName && parsed.emailFromName) {
		emailFromName = parsed.emailFromName;
		emailFromNameDefaulted = false;
	} else if (state?.emailFromName) {
		emailFromName = state.emailFromName;
		emailFromNameDefaulted = false;
	} else if (parsed.emailFromName) {
		emailFromName = parsed.emailFromName;
		emailFromNameDefaulted = false;
	}

	if (domain && publicOrigin && hostnameFromOrigin(publicOrigin) !== domain) {
		throw usage('--public-origin and --domain must agree (domain implies https://<domain>)');
	}

	return {
		accountId: parsed.accountId,
		workerName,
		d1,
		r2,
		domain,
		publicOrigin,
		d6eAuthBaseUrl,
		emailFrom,
		emailFromName,
		mailProvider,
		smtpHost,
		smtpPort,
		smtpSecure,
		smtpUsername,
		bootstrapOwnerEmail,
		inherited: {
			workerName: Boolean(state && !parsed.overrides.workerName),
			d1: Boolean(state && !parsed.overrides.d1),
			r2: Boolean(state && !parsed.overrides.r2),
			domain: Boolean(state && !parsed.overrides.domain),
			publicOrigin: Boolean(state && !parsed.overrides.publicOrigin && !parsed.overrides.domain),
			d6eAuthBaseUrl: Boolean(state && !parsed.overrides.d6eAuthBaseUrl),
			emailFrom: Boolean(state && !parsed.overrides.emailFrom),
			emailFromName: Boolean(state && !parsed.overrides.emailFromName),
			mailProvider: Boolean(state && !parsed.overrides.mailProvider),
			smtpHost: Boolean(state && !parsed.overrides.smtpHost),
			smtpPort: Boolean(state && !parsed.overrides.smtpPort),
			smtpSecure: Boolean(state && !parsed.overrides.smtpSecure),
			smtpUsername: Boolean(state && !parsed.overrides.smtpUsername),
			bootstrapOwnerEmail: Boolean(state && !parsed.overrides.bootstrapOwnerEmail)
		},
		appliedDefaults: {
			d6eAuthBaseUrl: d6eAuthBaseUrlDefaulted,
			emailFromName: emailFromNameDefaulted
		}
	};
}

function resolvePublicOrigin(
	parsed: ParsedCommand,
	state: DeploymentState | undefined,
	domain: string | undefined
): string | undefined {
	if (parsed.overrides.publicOrigin && parsed.publicOrigin) {
		return parsed.publicOrigin;
	}
	if (parsed.overrides.domain && domain) {
		return originFromDomain(domain);
	}
	if (state?.publicOrigin) {
		return state.publicOrigin;
	}
	if (domain) {
		return originFromDomain(domain);
	}
	return undefined;
}
