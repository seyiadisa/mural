import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [{
    name: 'mural-web-setup-guide',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/docs/web-app.md') return next();
        void readFile(fileURLToPath(new URL('../../docs/web-app.md', import.meta.url)))
          .then(content => { response.statusCode = 200; response.setHeader('Content-Type', 'text/markdown; charset=utf-8'); response.end(content); })
          .catch(next);
      });
    }
  }],
  server: {
    proxy: {
      '/v1': { target: process.env.MURAL_API_DEV_ORIGIN ?? 'http://localhost:8080', changeOrigin: false },
      '/healthz': { target: process.env.MURAL_API_DEV_ORIGIN ?? 'http://localhost:8080', changeOrigin: false },
      '/readyz': { target: process.env.MURAL_API_DEV_ORIGIN ?? 'http://localhost:8080', changeOrigin: false }
    }
  }
});
