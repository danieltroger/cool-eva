import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// ⚠️ MapLibre MUST NOT be pre-bundled. Its ESM build creates the tile worker with
	// `new Worker(new URL('./maplibre-gl-worker.mjs', import.meta.url))`, and Vite's dependency
	// optimizer rewrites the entry to node_modules/.vite/deps/maplibre-gl.js without moving the
	// worker beside it — so the worker 404s. MapLibre 6.10.0 reports that NOWHERE: no `error`
	// event, no console message, no exception. The symptom is a map that loads its style, its
	// sprites and its raster tiles, never requests a vector tile, leaves `isStyleLoaded()` false
	// for ever and paints a flat background. Measured here, not guessed; the fix that would have
	// reported it (PR #8454) merged 34 minutes after 6.10.0 was published.
	optimizeDeps: { exclude: ['maplibre-gl'] },
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	]
});
