import { v7 as encodeUuidV7 } from 'uuid';

/**
 * The single source of persistent SignKit identifiers.
 *
 * Every application-owned row identifier — envelopes, recipients, fields,
 * audit events, delivery intents, completion delivery grants, and workload key
 * records — is a canonical lowercase RFC 9562 UUIDv7 minted here before the row
 * is written. Database-native `uuidv7()` is deliberately not the generator: D1
 * has no such function, and commands hash, seal, and audit their identifiers
 * before any statement runs.
 *
 * The embedded millisecond timestamp is metadata and a coarse ordering hint
 * only. It is never authorization, tenant evidence, trusted event time, or a
 * substitute for the audit chain's own `sequence` and `occurred_at` columns.
 *
 * Opaque security material — recipient capabilities, completion access grants,
 * workload key secrets, OAuth state, session nonces, and delivery claim tokens
 * — must never be minted here: a UUIDv7 carries only 74 random bits and leaks
 * its creation time. Caller-chosen idempotency keys are also not identifiers:
 * first-party browsers mint UUIDv4 via `crypto.randomUUID()`, and the server
 * accepts bounded arbitrary keys without parsing UUID structure.
 *
 * RFC 9562 byte encoding comes from the `uuid` package. Monotonic
 * same-millisecond sequencing and the clock-rollback policy live here so both
 * production and injected-clock tests exercise the same state machine.
 */

/** Canonical lowercase UUIDv7: version nibble `7`, variant bits `10xx`. */
export const UUID_V7_PATTERN: RegExp =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Largest timestamp representable in the 48-bit UUIDv7 `unix_ts_ms` field. */
export const MAX_UUID_V7_TIMESTAMP_MS: number = 2 ** 48 - 1;

const RANDOM_BYTE_LENGTH: number = 16;
/** `rand_a` (12 bits) plus the leading 19 bits of `rand_b`, per RFC 9562 method 2. */
const MAX_SEQUENCE: number = 0x7fffffff;

export type UuidV7Generator = () => string;

export interface UuidV7GeneratorOptions {
	/** Millisecond wall clock. Defaults to `Date.now`. */
	now?: () => number;
	/** Returns 16 cryptographically random bytes. Defaults to `crypto.getRandomValues`. */
	randomBytes?: () => Uint8Array;
}

export class InvalidUuidV7ClockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidUuidV7ClockError';
	}
}

export class InvalidUuidV7EntropyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidUuidV7EntropyError';
	}
}

interface GeneratorState {
	timestampMs: number;
	sequence: number;
}

/**
 * Creates an independent generator. Callers inject a clock and an entropy
 * source in tests; production uses the process clock and Web Crypto, which is
 * available on Node, Cloudflare Workers, and Vercel alike.
 *
 * Successive identifiers from one generator are strictly increasing, both as
 * byte strings and lexically as text. Within a millisecond the 31-bit sequence
 * seeded from fresh entropy is incremented. If the wall clock moves backwards
 * — NTP correction, suspend/resume, a container clock jump — the generator
 * keeps the last emitted timestamp and keeps incrementing the sequence instead
 * of emitting an identifier that would sort before an already-persisted row;
 * the embedded time is then a bounded overestimate until the clock catches up.
 */
export function createUuidV7Generator(options: UuidV7GeneratorOptions = {}): UuidV7Generator {
	const now: () => number = options.now ?? ((): number => Date.now());
	const randomBytes: () => Uint8Array =
		options.randomBytes ??
		((): Uint8Array => crypto.getRandomValues(new Uint8Array(RANDOM_BYTE_LENGTH)));
	const state: GeneratorState = { timestampMs: -1, sequence: 0 };

	return function nextUuidV7(): string {
		const entropy: Uint8Array = readEntropy(randomBytes);
		const clockMs: number = readClock(now);
		if (clockMs > state.timestampMs) {
			state.timestampMs = clockMs;
			state.sequence = seedSequence(entropy);
		} else if (state.sequence < MAX_SEQUENCE) {
			// Same millisecond, or a clock that moved backwards: never emit a
			// timestamp earlier than one already handed out.
			state.sequence += 1;
		} else {
			// 2^31 identifiers inside one millisecond. Borrow from the next
			// millisecond rather than wrapping into an out-of-order sequence.
			state.timestampMs = assertTimestamp(state.timestampMs + 1);
			state.sequence = seedSequence(entropy);
		}
		return encodeUuidV7({
			msecs: state.timestampMs,
			seq: state.sequence,
			random: entropy
		});
	};
}

/** The process-wide generator for persistent SignKit identifiers. */
export const newUuidV7: UuidV7Generator = createUuidV7Generator();

export function isUuidV7(value: string): boolean {
	return UUID_V7_PATTERN.test(value);
}

/**
 * Reads the embedded `unix_ts_ms` field. Useful for diagnostics and coarse
 * ordering only; see the module contract above.
 */
export function uuidV7TimestampMs(value: string): number {
	if (!isUuidV7(value)) {
		throw new TypeError('Value is not a canonical lowercase UUIDv7');
	}
	return Number.parseInt(`${value.slice(0, 8)}${value.slice(9, 13)}`, 16);
}

function readClock(now: () => number): number {
	return assertTimestamp(now());
}

function assertTimestamp(timestampMs: number): number {
	if (
		!Number.isSafeInteger(timestampMs) ||
		timestampMs < 0 ||
		timestampMs > MAX_UUID_V7_TIMESTAMP_MS
	) {
		throw new InvalidUuidV7ClockError('UUIDv7 requires a millisecond clock within 48 bits');
	}
	return timestampMs;
}

function readEntropy(randomBytes: () => Uint8Array): Uint8Array {
	const entropy: Uint8Array = randomBytes();
	if (entropy.length !== RANDOM_BYTE_LENGTH) {
		throw new InvalidUuidV7EntropyError('UUIDv7 requires 16 random bytes');
	}
	return entropy;
}

function seedSequence(entropy: Uint8Array): number {
	return ((entropy[6] & 0x7f) << 24) | (entropy[7] << 16) | (entropy[8] << 8) | entropy[9];
}
