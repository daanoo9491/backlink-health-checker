import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

// The Cloudflare plugin runs the Worker inside workerd during `npm run dev`,
// so local development matches production.
export default defineConfig({
  plugins: [react(), cloudflare()],
});
