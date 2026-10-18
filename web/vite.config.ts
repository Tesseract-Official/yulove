import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Cognito's callback URL for local development is http://localhost:5173/auth/callback.
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Screen tests render the whole app; when the whole workspace's tests run at once they can
    // pass the 5 second default on a busy machine.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
