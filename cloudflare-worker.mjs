import svelteKitWorker from './.svelte-kit/cloudflare/_worker.js';
import { runScheduledMaintenance } from './src/lib/cloudflare/scheduled-maintenance.ts';

export default {
	fetch(request, environment, context) {
		return svelteKitWorker.fetch(request, environment, context);
	},

	scheduled(_controller, environment, context) {
		runScheduledMaintenance(
			(request, env, ctx) => svelteKitWorker.fetch(request, env, ctx),
			environment,
			context
		);
	}
};
