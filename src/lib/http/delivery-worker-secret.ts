import { env } from '$env/dynamic/private';
import { BEARER_SECRET_PATTERN } from '$lib/security/bearer-secret';

export type DeliveryWorkerSecretResolver = (platform?: Readonly<App.Platform>) => string | null;

export function resolveDeliveryWorkerSecret(platform?: Readonly<App.Platform>): string | null {
	const value: string | undefined =
		platform?.env?.DELIVERY_WORKER_SECRET ?? env.DELIVERY_WORKER_SECRET;
	if (value === undefined || !BEARER_SECRET_PATTERN.test(value)) return null;
	return value;
}
