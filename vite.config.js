import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Configure proxy for WindBorne API
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/windborne': {
        target: 'https://a.windbornesystems.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/windborne/, '')
      }
    }
  }
});
