export const envelopeStatuses = [
	'draft',
	'ready',
	'sent',
	'in_progress',
	'completed',
	'declined',
	'expired',
	'voided'
] as const;

export type EnvelopeStatus = (typeof envelopeStatuses)[number];
export type RecipientRole = 'signer' | 'approver' | 'viewer' | 'prefill' | 'cc';
export type RecipientStatus = 'pending' | 'viewed' | 'completed' | 'declined';

export interface Envelope {
	id: string;
	organizationId: string;
	title: string;
	status: EnvelopeStatus;
	repositoryGeneration: number;
	repositoryHead: string | null;
	repositoryArchiveKey: string | null;
	repositoryArchiveSha256: string | null;
	sentCommitSha: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface EnvelopeDocument {
	id: string;
	organizationId: string;
	envelopeId: string;
	markdownPath: `documents/${string}.md`;
	title: string;
	position: number;
}

export interface Recipient {
	id: string;
	organizationId: string;
	envelopeId: string;
	email: string;
	name: string;
	role: RecipientRole;
	locale: 'en' | 'ja';
	routingOrder: number;
	status: RecipientStatus;
}

const allowedTransitions: Readonly<Record<EnvelopeStatus, readonly EnvelopeStatus[]>> = {
	draft: ['ready', 'voided'],
	ready: ['draft', 'sent', 'voided'],
	sent: ['in_progress', 'completed', 'declined', 'expired', 'voided'],
	in_progress: ['completed', 'declined', 'expired', 'voided'],
	completed: [],
	declined: [],
	expired: [],
	voided: []
};

export function canTransitionEnvelope(from: EnvelopeStatus, to: EnvelopeStatus): boolean {
	return allowedTransitions[from].includes(to);
}

export function assertEnvelopeMutable(status: EnvelopeStatus): void {
	if (status !== 'draft') throw new Error(`Envelope is immutable in ${status} state`);
}

export function assertMarkdownPath(path: string): asserts path is `documents/${string}.md` {
	if (!/^documents\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(path) || path.includes('..')) {
		throw new Error('Draft repositories accept Markdown files under documents/ only');
	}
}
