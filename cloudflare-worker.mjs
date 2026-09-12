import svelteKitWorker from './.svelte-kit/cloudflare/_worker.js';

const DELIVERY_DRAIN_URL = 'https://signkit.internal/api/v1/system/deliveries/drain';
const COMPLETION_ARTIFACT_DRAIN_URL =
	'https://signkit.internal/api/v1/system/completion-artifacts/drain';
const COMPLETION_DELIVERY_DRAIN_URL =
	'https://signkit.internal/api/v1/system/completion-deliveries/drain';

export default {
	fetch(request, environment, context) {
		return svelteKitWorker.fetch(request, environment, context);
	},

	scheduled(_controller, environment, context) {
		context.waitUntil(drainDeliveries(environment, context));
		context.waitUntil(drainCompletionArtifacts(environment, context));
		context.waitUntil(drainCompletionDeliveries(environment, context));
	}
};

async function drainDeliveries(environment, context) {
	if (typeof environment.DELIVERY_WORKER_SECRET !== 'string') {
		throw new Error('Delivery worker secret is unavailable');
	}
	const response = await svelteKitWorker.fetch(
		new Request(DELIVERY_DRAIN_URL, {
			method: 'POST',
			headers: { authorization: `Bearer ${environment.DELIVERY_WORKER_SECRET}` }
		}),
		environment,
		context
	);
	if (!response.ok) throw new Error(`Delivery drain failed with status ${response.status}`);
}

async function drainCompletionArtifacts(environment, context) {
	if (typeof environment.DELIVERY_WORKER_SECRET !== 'string') {
		throw new Error('Delivery worker secret is unavailable');
	}
	const response = await svelteKitWorker.fetch(
		new Request(COMPLETION_ARTIFACT_DRAIN_URL, {
			method: 'POST',
			headers: { authorization: `Bearer ${environment.DELIVERY_WORKER_SECRET}` }
		}),
		environment,
		context
	);
	if (!response.ok) {
		throw new Error(`Completion artifact drain failed with status ${response.status}`);
	}
}

async function drainCompletionDeliveries(environment, context) {
	if (typeof environment.DELIVERY_WORKER_SECRET !== 'string') {
		throw new Error('Delivery worker secret is unavailable');
	}
	const response = await svelteKitWorker.fetch(
		new Request(COMPLETION_DELIVERY_DRAIN_URL, {
			method: 'POST',
			headers: { authorization: `Bearer ${environment.DELIVERY_WORKER_SECRET}` }
		}),
		environment,
		context
	);
	if (!response.ok) {
		throw new Error(`Completion delivery drain failed with status ${response.status}`);
	}
}
