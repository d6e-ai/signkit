/**
 * Placement of the engine and validator containers.
 *
 * Both containers use the `durable_object` scheduling policy, so each runs where its Durable
 * Object lives. A Durable Object is created near its first request and is never relocated, so an
 * unhinted object stays wherever that first request happened to come from. An optional
 * `SEAL_LOCATION_HINT` asks Cloudflare to create the object in a region instead. The hint is part
 * of the object name: changing it addresses a new object (and container) in the new region rather
 * than an existing one that cannot move. Neither object stores data, so nothing is migrated.
 */

/** Cloudflare's Durable Object location hints. */
export const SEAL_LOCATION_HINTS = [
	'wnam',
	'enam',
	'sam',
	'weur',
	'eeur',
	'apac',
	'apac-ne',
	'apac-se',
	'oc',
	'afr',
	'me'
] as const satisfies readonly DurableObjectLocationHint[];

export type SealLocationHint = (typeof SEAL_LOCATION_HINTS)[number];

export function isSealLocationHint(value: unknown): value is SealLocationHint {
	return typeof value === 'string' && (SEAL_LOCATION_HINTS as readonly string[]).includes(value);
}

/**
 * The stub for the role's single container object. Without a hint this is the historical
 * unhinted object, so existing deployments keep their container. An unknown hint is a deployment
 * error and returns null so the caller fails closed instead of silently ignoring the setting.
 */
export function placedObject<T extends Rpc.DurableObjectBranded | undefined>(
	namespace: DurableObjectNamespace<T>,
	name: string,
	hint: string | undefined
): DurableObjectStub<T> | null {
	if (hint === undefined || hint === '') return namespace.getByName(name);
	if (!isSealLocationHint(hint)) return null;
	return namespace.getByName(`${name}-${hint}`, { locationHint: hint });
}
