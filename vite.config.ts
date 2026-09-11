import { paraglideVitePlugin } from '@inlang/paraglide-js';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import adapterNode from '@sveltejs/adapter-node';
import adapterVercel from '@sveltejs/adapter-vercel';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';

const deployTarget = process.env.DEPLOY_TARGET ?? 'node';

function deploymentAdapter() {
	switch (deployTarget) {
		case 'cloudflare':
			return adapterCloudflare({ config: 'wrangler.build.jsonc' });
		case 'vercel':
			return adapterVercel({ runtime: 'nodejs22.x' });
		case 'node':
			return adapterNode({ out: 'build/node' });
		default:
			throw new Error(`Unsupported DEPLOY_TARGET: ${deployTarget}`);
	}
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter: deploymentAdapter(),
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'base-uri': ['none'],
					'connect-src': ['self'],
					'font-src': ['self'],
					'form-action': ['self'],
					'frame-ancestors': ['none'],
					'frame-src': ['none'],
					'img-src': ['self', 'data:'],
					'media-src': ['none'],
					'object-src': ['none'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'worker-src': ['self']
				}
			}
		}),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			emitTsDeclarations: true,
			strategy: ['url', 'cookie', 'baseLocale'],
			urlPatterns: [
				{
					pattern: ':protocol://:domain(.*)::port?/:path(.*)?',
					localized: [
						['en', ':protocol://:domain(.*)::port?/en/:path(.*)?'],
						['ja', ':protocol://:domain(.*)::port?/ja/:path(.*)?']
					]
				}
			]
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'src/**/*.browser.spec.ts']
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'browser',
					include: ['src/**/*.browser.spec.ts'],
					browser: {
						enabled: true,
						headless: true,
						provider: playwright(),
						instances: [{ browser: 'chromium' }]
					}
				}
			}
		]
	}
});
