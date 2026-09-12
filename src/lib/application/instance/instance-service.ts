import {
	isInstanceIdempotencyKey,
	type BootstrapInstanceCommand,
	type BootstrapInstanceStoreResult,
	type InstanceCallerContext,
	type InstanceStore
} from '$lib/ports/instance-store';

export interface InstanceBootstrapActor {
	id: string;
}

export interface BootstrapInstanceInput {
	idempotencyKey: string;
}

export type BootstrapInstanceResult = BootstrapInstanceStoreResult;

export interface InstanceApplicationPort {
	bootstrapInstance(
		actor: InstanceBootstrapActor,
		input: BootstrapInstanceInput
	): Promise<BootstrapInstanceResult>;
	getCurrentMember(actor: InstanceBootstrapActor): Promise<InstanceCallerContext>;
}

export class InvalidInstanceBootstrapRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidInstanceBootstrapRequestError';
	}
}

/**
 * Instance owner bootstrap and caller membership application.
 *
 * Coordinates request normalization, request fingerprint calculation over the
 * empty JSON payload, and durable store execution.
 */
export class InstanceApplication implements InstanceApplicationPort {
	constructor(
		private readonly store: InstanceStore,
		private readonly now: () => Date = (): Date => new Date()
	) {}

	async bootstrapInstance(
		actor: InstanceBootstrapActor,
		input: BootstrapInstanceInput
	): Promise<BootstrapInstanceResult> {
		if (typeof actor.id !== 'string' || actor.id.length < 1 || actor.id.length > 200) {
			throw new InvalidInstanceBootstrapRequestError('Invalid actor user identifier.');
		}
		if (!isInstanceIdempotencyKey(input.idempotencyKey)) {
			throw new InvalidInstanceBootstrapRequestError(
				'Idempotency-Key must contain visible ASCII characters only.'
			);
		}

		// The body is strictly empty JSON object `{}`. Canonical JSON serialization:
		const requestFingerprint: string = await sha256('{}');
		const createdAt: string = this.now().toISOString();

		const command: BootstrapInstanceCommand = {
			actor: { type: 'user', id: actor.id },
			idempotencyKey: input.idempotencyKey,
			requestFingerprint,
			createdAt
		};

		return this.store.bootstrapInstance(command);
	}

	async getCurrentMember(actor: InstanceBootstrapActor): Promise<InstanceCallerContext> {
		return this.store.getInstanceCallerContext(actor.id);
	}
}

async function sha256(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest))
		.map((byte: number): string => byte.toString(16).padStart(2, '0'))
		.join('');
}
