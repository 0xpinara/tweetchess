import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Runs the Worker + Durable Objects inside Vite (dev and preview) using wrangler.jsonc.
    // End-to-end tests start from empty storage so every run is reproducible.
    cloudflare({ persistState: !process.env.TWEETCHESS_E2E }),
  ],
});
