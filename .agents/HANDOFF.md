# Session Handoff

## Last Completed Task
- Replaced the Render Caddy runtime with Fastify serving the built SPA and API from the same origin. Added the Render-only `MURAL_TRUST_RENDER_EDGE=true` gate for `CF-Connecting-IP`, same-origin security headers, static-file traversal checks, SPA fallback, and focused regression tests.
- Commits `0a3824c` (`feat: serve web app from Fastify`) and `a73f741` (`fix: remove Caddy from Render runtime`) were pushed to `origin/main`. The previous local Caddy-diagnostic commit `16d35f0` was pushed with them.
- Render Blueprint validation passed. Deployment `dep-dbfk1gbphbkc73agr3ig` is live on commit `a73f741fdd570930605551490ad7208e3cef7a62`.
- Public checks passed: `/healthz`, Neon-backed `/readyz`, homepage, built JS asset, SPA fallback, JSON API 404, CSP/HSTS headers, and `/v1/auth/providers` (`google: true`). Hosted voice remains disabled.
- The Render Docker build compiled the API and web app. `node --check infra/render/container-entrypoint.mjs` and `git diff --check` passed. Local Docker is unavailable; local pnpm checks could not open the user-level pnpm SQLite store, so the API unit suite was not run locally.

## Current State
- Render service `srv-dbee9d7b9u1s739e3vmg` is running one instance in Frankfurt at `https://mural-ygi6.onrender.com`. The live image serves the SPA and API directly from Fastify.
- Neon remains in `eu-central-1`; no secrets or database credentials were changed. This patch contains no migration changes. `/readyz` returned `{ "database": true }`.
- `MURAL_TRUST_RENDER_EDGE=true` is set by `render.yaml`; the API ignores `CF-Connecting-IP` unless that flag is enabled. `HOSTED_VOICE_EXPERIMENTAL=false` and `HOSTED_VOICE_LIFETIME_CAP_NANO=0` remain in effect.
- The current deployment is the first successful Render image. Earlier Caddy images failed at runtime, so they are not a usable rollback target. Roll back with a reviewed code revert and new deploy if needed.

## Next Task
- Complete owner Google sign-in in the browser. It was not exercised interactively. Then import the laptop's SIWC credentials using the `web-admin` workflow in `docs/web-app.md`.
- If testing code locally, restore pnpm's access to its package store or use a clean local dependency install; do not point database tests at Neon production.

## Open Issues
- Interactive owner sign-in and SIWC import remain unverified. No OpenAI Live credentials are configured; voice stays intentionally paused.
- The local API unit suite was not run because pnpm could not open its user-level SQLite store in the sandbox. The hosted image build and public route checks succeeded.
