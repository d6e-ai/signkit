import { paraglideVitePlugin } from '@inlang/paraglide-js';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import adapterNode from '@sveltejs/adapter-node';
import adapterVercel from '@sveltejs/adapter-vercel';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

const deployTarget = process.env.DEPLOY_TARGET ?? 'node';

function deploymentAdapter() {
	switch (deployTarget) {
		case 'cloudflare':
			return adapterCloudflare();
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

			adapter: deploymentAdapter()
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
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
