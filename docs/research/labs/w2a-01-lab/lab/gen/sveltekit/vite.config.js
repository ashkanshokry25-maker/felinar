import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-static';
export default {
  plugins: [sveltekit({
    adapter: adapter({ pages: process.env.OUT || 'build', assets: process.env.OUT || 'build', fallback: process.env.FALLBACK || undefined }),
    paths: { base: process.env.BASE_PATH || '' },
  })],
};
