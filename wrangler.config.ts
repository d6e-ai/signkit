import { defineWranglerConfig } from 'wrangler/experimental-config';

export default defineWranglerConfig({
	assetsDirectory: '.svelte-kit/cloudflare',
	types: { generate: false }
});
