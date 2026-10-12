import type { InstanceCallerContext } from '$lib/ports/instance-store';

export interface RequestCallerContextLocals {
	/** Request-owned only: never retain this map in module-global state. */
	requestCallerContexts?: Map<string, Promise<InstanceCallerContext>>;
}

/**
 * Resolves (and caches) `InstanceCallerContext` for `callerId` within this
 * request. The first call for a given `(locals, callerId)` pair invokes
 * `resolve`; every subsequent call for the same pair -- whether the first
 * call has settled yet or not -- returns that same promise, so a rejection is
 * observed by every caller exactly as it occurred, without a silent retry.
 */
export function getRequestCallerContext(
	locals: RequestCallerContextLocals,
	callerId: string,
	resolve: () => Promise<InstanceCallerContext>
): Promise<InstanceCallerContext> {
	let snapshots: Map<string, Promise<InstanceCallerContext>> | undefined =
		locals.requestCallerContexts;
	if (snapshots === undefined) {
		snapshots = new Map();
		locals.requestCallerContexts = snapshots;
	}
	let snapshot: Promise<InstanceCallerContext> | undefined = snapshots.get(callerId);
	if (snapshot === undefined) {
		snapshot = Promise.resolve().then(resolve);
		snapshots.set(callerId, snapshot);
	}
	return snapshot;
}
