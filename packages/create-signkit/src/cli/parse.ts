import {
	COMMANDS,
	DEFAULT_CHANNEL,
	DEFAULT_D1_NAME,
	DEFAULT_D6E_AUTH_BASE_URL,
	DEFAULT_EMAIL_FROM_NAME,
	DEFAULT_R2_NAME,
	DEFAULT_VERSION,
	DEFAULT_WORKER_NAME,
	PACKAGE_NAME,
	PACKAGE_VERSION,
	PROVIDER_FLAGS,
	SECRET_FLAG_NAMES
} from '../constants.js';
import { parseReleaseTag } from '../release/semver.js';
import { usage } from './errors.js';
import { parseEmailAddress, parseHttpsOrigin } from './urls.js';

export type ProviderId = 'cloudflare' | 'node' | 'vercel';
export type CommandName = (typeof COMMANDS)[number];
export type ReleaseChannel = 'stable' | 'beta';

export interface ParsedCommand {
	kind: 'command';
	provider: ProviderId;
	command: CommandName;
	accountId: string;
	workerName: string;
	d1: string;
	r2: string;
	domain?: string;
	publicOrigin?: string;
	d6eAuthBaseUrl?: string;
	emailFrom?: string;
	emailFromName?: string;
	bootstrapOwnerEmail?: string;
	version: string;
	channel: ReleaseChannel;
	statePath?: string;
	yes: boolean;
	json: boolean;
	overrides: {
		workerName: boolean;
		d1: boolean;
		r2: boolean;
		domain: boolean;
		publicOrigin: boolean;
		d6eAuthBaseUrl: boolean;
		emailFrom: boolean;
		emailFromName: boolean;
		bootstrapOwnerEmail: boolean;
	};
}

export interface ParsedHelp {
	kind: 'help';
}

export interface ParsedCliVersion {
	kind: 'cli-version';
}

export type ParsedArgv = ParsedCommand | ParsedHelp | ParsedCliVersion;

const PROVIDER_FLAG_SET = new Set(Object.values(PROVIDER_FLAGS));
const COMMAND_SET = new Set<string>(COMMANDS);
const BOOLEAN_OPTION_FLAGS = new Set(['yes', 'json', 'help', 'cli-version']);
const VALUE_OPTION_FLAGS = new Set([
	'account-id',
	'worker-name',
	'd1',
	'r2',
	'domain',
	'public-origin',
	'd6e-auth-base-url',
	'email-from',
	'email-from-name',
	'bootstrap-owner-email',
	'version',
	'channel',
	'state'
]);

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const WORKER_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const R2_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const D1_NAME_PATTERN = /^[a-z0-9]([_a-z0-9-]{0,62}[a-z0-9])?$/i;
const D1_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN_PATTERN =
	/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function parseArgv(argv: string[]): ParsedArgv {
	const providerFlags: ProviderId[] = [];
	let command: string | undefined;
	let help = false;
	let cliVersion = false;
	let yes = false;
	let json = false;
	const values = new Map<string, string>();
	const seenValueFlags = new Set<string>();

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) {
			break;
		}
		if (arg === '--') {
			throw usage('unexpected arguments after --');
		}
		if (arg === '-h' || arg === '--help') {
			help = true;
			continue;
		}
		if (arg === '-V' || arg === '--cli-version') {
			cliVersion = true;
			continue;
		}
		if (arg.startsWith('--')) {
			const eq = arg.indexOf('=');
			const rawName = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
			const name = rawName.toLowerCase();
			if (SECRET_FLAG_NAMES.has(name) || name.includes('secret') || name.includes('token')) {
				throw usage(
					`refusing secret-bearing flag --${rawName}; secrets are never accepted on argv (use Wrangler secret storage, interactive stdin, or documented environment channels)`
				);
			}
			let value: string | undefined;
			if (eq !== -1) {
				value = arg.slice(eq + 1);
			}
			if (PROVIDER_FLAG_SET.has(name as ProviderId)) {
				if (command !== undefined) {
					throw usage(
						`provider flag --${name} must appear before the command; got command "${command}" first`
					);
				}
				const enabled = value === undefined ? true : parseBooleanFlag(name, value);
				if (enabled) {
					providerFlags.push(name as ProviderId);
				}
				continue;
			}
			if (BOOLEAN_OPTION_FLAGS.has(name)) {
				const enabled = value === undefined ? true : parseBooleanFlag(name, value);
				if (name === 'yes') yes = enabled;
				if (name === 'json') json = enabled;
				if (name === 'help') help = enabled;
				if (name === 'cli-version') cliVersion = enabled;
				continue;
			}
			if (VALUE_OPTION_FLAGS.has(name)) {
				if (value === undefined) {
					const next = argv[i + 1];
					if (next === undefined || next.startsWith('-')) {
						throw usage(`--${name} requires a value`);
					}
					value = next;
					i += 1;
				}
				if (seenValueFlags.has(name)) {
					throw usage(`duplicate flag --${name}`);
				}
				seenValueFlags.add(name);
				values.set(name, value);
				continue;
			}
			throw usage(`unknown flag --${rawName}`);
		}
		if (arg.startsWith('-')) {
			throw usage(`unknown flag ${arg}`);
		}
		if (command !== undefined) {
			throw usage(`unexpected argument "${arg}"`);
		}
		command = arg;
	}

	if (help) {
		return { kind: 'help' };
	}
	if (cliVersion) {
		return { kind: 'cli-version' };
	}

	if (providerFlags.length === 0) {
		throw usage(
			`${PACKAGE_NAME} requires an explicit provider flag before the command (for example: ${PACKAGE_NAME} --cloudflare plan). Cloudflare is not an implicit default.`
		);
	}
	if (providerFlags.length > 1) {
		throw usage(
			`provider flags are mutually exclusive; received ${providerFlags.map((flag) => `--${flag}`).join(' and ')}`
		);
	}
	if (command === undefined) {
		throw usage(`missing command; expected one of: ${COMMANDS.join(', ')}`);
	}
	if (!COMMAND_SET.has(command)) {
		throw usage(`unknown command "${command}"; expected one of: ${COMMANDS.join(', ')}`);
	}

	const accountId = values.get('account-id');
	if (!accountId) {
		throw usage('--account-id is required');
	}
	if (!ACCOUNT_ID_PATTERN.test(accountId)) {
		throw usage('--account-id must be a 32-character hexadecimal Cloudflare account id');
	}

	const channelRaw = values.get('channel') ?? DEFAULT_CHANNEL;
	if (channelRaw !== 'stable' && channelRaw !== 'beta') {
		throw usage('--channel must be stable or beta');
	}

	const version = values.get('version') ?? DEFAULT_VERSION;
	validateVersionSelector(version);

	const workerName = values.get('worker-name') ?? DEFAULT_WORKER_NAME;
	if (!WORKER_NAME_PATTERN.test(workerName)) {
		throw usage(
			'--worker-name must be a DNS-label Worker name (lowercase alphanumeric and hyphens)'
		);
	}

	const d1 = values.get('d1') ?? DEFAULT_D1_NAME;
	if (!D1_NAME_PATTERN.test(d1) && !D1_ID_PATTERN.test(d1)) {
		throw usage('--d1 must be a D1 database name or UUID');
	}

	const r2 = values.get('r2') ?? DEFAULT_R2_NAME;
	if (!R2_NAME_PATTERN.test(r2)) {
		throw usage('--r2 must be a valid R2 bucket name');
	}

	const domainRaw = values.get('domain');
	if (domainRaw !== undefined && !DOMAIN_PATTERN.test(domainRaw)) {
		throw usage('--domain must be a DNS hostname (no scheme or path)');
	}
	const domain = domainRaw?.toLowerCase();

	const publicOriginRaw = values.get('public-origin');
	const publicOrigin =
		publicOriginRaw === undefined
			? undefined
			: parseHttpsOrigin(publicOriginRaw, '--public-origin');
	const d6eAuthBaseUrlRaw = values.get('d6e-auth-base-url');
	const d6eAuthBaseUrl =
		d6eAuthBaseUrlRaw === undefined
			? undefined
			: parseHttpsOrigin(d6eAuthBaseUrlRaw, '--d6e-auth-base-url');
	const emailFromRaw = values.get('email-from');
	const emailFrom =
		emailFromRaw === undefined ? undefined : parseEmailAddress(emailFromRaw, '--email-from');
	const emailFromName = values.get('email-from-name')?.trim();
	if (emailFromName !== undefined && (emailFromName.length === 0 || emailFromName.includes('\0'))) {
		throw usage('--email-from-name must be nonempty text');
	}
	const bootstrapOwnerEmailRaw = values.get('bootstrap-owner-email');
	// Non-secret deployment configuration (like --email-from): validated and
	// canonicalized to trimmed lowercase so the Worker var exactly matches the
	// verified d6e-auth email comparison. Never logged; applied as a plain var.
	const bootstrapOwnerEmail =
		bootstrapOwnerEmailRaw === undefined
			? undefined
			: parseEmailAddress(bootstrapOwnerEmailRaw, '--bootstrap-owner-email').toLowerCase();

	if (domain && publicOrigin) {
		const implied = `https://${domain}`;
		if (publicOrigin !== implied) {
			throw usage('--public-origin and --domain must agree (domain implies https://<domain>)');
		}
	}

	return {
		kind: 'command',
		provider: providerFlags[0]!,
		command: command as CommandName,
		accountId: accountId.toLowerCase(),
		workerName,
		d1,
		r2,
		domain,
		publicOrigin,
		d6eAuthBaseUrl,
		emailFrom,
		emailFromName,
		bootstrapOwnerEmail,
		version,
		channel: channelRaw,
		statePath: values.get('state'),
		yes,
		json,
		overrides: {
			workerName: values.has('worker-name'),
			d1: values.has('d1'),
			r2: values.has('r2'),
			domain: values.has('domain'),
			publicOrigin: values.has('public-origin'),
			d6eAuthBaseUrl: values.has('d6e-auth-base-url'),
			emailFrom: values.has('email-from'),
			emailFromName: values.has('email-from-name'),
			bootstrapOwnerEmail: values.has('bootstrap-owner-email')
		}
	};
}

function parseBooleanFlag(name: string, value: string): boolean {
	if (value === 'true' || value === '1') return true;
	if (value === 'false' || value === '0') return false;
	throw usage(`--${name} is a boolean flag and does not take "${value}"`);
}

function validateVersionSelector(version: string): void {
	if (version === 'latest') {
		return;
	}
	try {
		parseReleaseTag(version);
	} catch (error) {
		throw usage(
			`--version must be "latest" or an exact release tag such as v1.2.3 without build metadata; refusing git ref "${version}"${error instanceof Error ? `: ${error.message}` : ''}`
		);
	}
}

export function argvRequestsJson(argv: readonly string[]): boolean {
	let json = false;
	for (const arg of argv) {
		if (arg === '--json') {
			json = true;
			continue;
		}
		if (!arg.startsWith('--json=')) {
			continue;
		}
		const value = arg.slice('--json='.length);
		if (value === 'true' || value === '1') {
			json = true;
		} else if (value === 'false' || value === '0') {
			json = false;
		}
	}
	return json;
}

export function helpText(): string {
	return `${PACKAGE_NAME} ${PACKAGE_VERSION}

Deploy SignKit from GitHub Releases. This is the Cloudflare deployment CLI,
not the Rust SignKit API CLI (the \`signkit\` binary under cli/).

Usage:
  ${PACKAGE_NAME} --cloudflare <plan|deploy|adopt|upgrade> --account-id <id> [options]

The provider flag is required and must appear before the command. There is no
implicit Cloudflare default. Future --node and --vercel flags are mutually
exclusive with --cloudflare.

Commands:
  plan      Read-only: resolve a release, inspect resources, print the plan
  deploy    Create missing D1/R2 if needed and deploy the Worker
  adopt     Record existing Worker/D1/R2 in local state (does not select a release)
  upgrade   Require existing resources, apply pending migrations, upload Worker

Options:
  --account-id <id>       Cloudflare account ID (required; never inherited)
  --worker-name <name>    Worker name (default: ${DEFAULT_WORKER_NAME}; omitted flags inherit XDG state)
  --d1 <name-or-id>       D1 database name or UUID (default: ${DEFAULT_D1_NAME})
  --r2 <name>             R2 bucket name (default: ${DEFAULT_R2_NAME})
  --domain <hostname>     Optional custom domain (implies https://<hostname>)
  --public-origin <url>   Public https origin (must agree with --domain when both are set)
  --d6e-auth-base-url <url>  d6e-auth origin (default: ${DEFAULT_D6E_AUTH_BASE_URL})
  --email-from <email>    SIGNKIT_EMAIL_FROM (required for the initial managed deploy)
  --email-from-name <text>   SIGNKIT_EMAIL_FROM_NAME (default: ${DEFAULT_EMAIL_FROM_NAME})
  --bootstrap-owner-email <email>  SIGNKIT_BOOTSTRAP_OWNER_EMAIL as a non-secret Worker var (required for deploy/upgrade; uninitialized instances fail closed without it)
  --version <tag|latest>  Release tag or "latest" (default: latest)
  --channel <stable|beta> Release channel (enforced against the selected tag; used to pick latest)

  --state <path>          Deployment state file (default: XDG state home)
  --yes                   Confirm mutating commands
  --json                  Write a machine-readable result to stdout
  -h, --help              Show this help
  --cli-version           Print ${PACKAGE_NAME} version

Omitted worker/D1/R2/domain/origin/mail flags inherit existing XDG state before
any Cloudflare inspection. Identity drift requires --cloudflare adopt.
SIGNKIT_MAIL_PROVIDER is always cloudflare. Secrets are never accepted on argv.
Worker rollback cannot roll back D1. See docs/create-signkit.md.
`;
}
