import type { InstanceCallerContext } from '$lib/ports/instance-store';

/**
 * Caches `getCurrentMember` lookups per request and caller id, keyed by the
 * SvelteKit `locals` object -- created fresh per request and threaded
 * unchanged into every `load` function -- so the hook and the root layout
 * share one durable read for the same caller instead of issuing it twice.
 * The `WeakMap` entry is unreachable, and reclaimable, the moment the
 * request's `locals` object is: never shared across requests, and never
 * shared between different callers within the same request.
 */
const snapshotsByRequest = new WeakMap<object, Map<string, Promise<InstanceCallerContext>>>();

/**
 * Resolves (and caches) `InstanceCallerContext` for `callerId` within this
 * request. The first call for a given `(requestKey, callerId)` pair invokes
 * `resolve`; every subsequent call for the same pair -- whether the first
 * call has settled yet or not -- returns that same promise, so a rejection is
 * observed by every caller exactly as it occurred, without a silent retry.
 */
export function getRequestCallerContext(
	requestKey: object,
	callerId: string,
	resolve: () => Promise<InstanceCallerContext>
): Promise<InstanceCallerContext> {
	let snapshots: Map<string, Promise<InstanceCallerContext>> | undefined =
		snapshotsByRequest.get(requestKey);
	if (snapshots === undefined) {
		snapshots = new Map();
		snapshotsByRequest.set(requestKey, snapshots);
	}
	let snapshot: Promise<InstanceCallerContext> | undefined = snapshots.get(callerId);
	if (snapshot === undefined) {
		snapshot = resolve();
		snapshots.set(callerId, snapshot);
	}
	return snapshot;
}
