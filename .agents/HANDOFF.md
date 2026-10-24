# Session Handoff

## Last Completed Task
- Prepared and validated a Render Docker deployment for the private Mural web app, with Neon PostgreSQL.
- Built local image `mural-render:verification`; API and web builds passed inside Docker, Caddy config validated, Render Blueprint validation succeeded.
- Added a pnpm 11 `allowBuilds` policy for esbuild only, required for reproducible Docker builds.
- Branch: `main`; commits `cecf22c` (Render implementation) and `da8f056` (deployment documentation) are pushed to `origin/main`.

## Current State
- Render project: `Mural` (`prj-dbec94gm7kps73de22c0`); Production environment: `evm-dbec94gm7kps73de22cg`.
- Render CLI confirms Production has no services or environment groups. No service or deployment has been created.
- `render.yaml` passes live Blueprint validation and pins Render to Frankfurt to match Neon `eu-central-1`; this is set before service creation because Render does not allow changing a service's region later.
- No Neon URLs, Google Web client ID, owner email, or app secrets are available in this checkout or Render Production.
- The local Docker build used `VITE_GOOGLE_CLIENT_ID=render-verification-placeholder`; do not deploy that verification image. Render must build the source with the real OAuth client ID.
- Hosted voice remains off (`HOSTED_VOICE_EXPERIMENTAL=false`, cap `0`); GPT-Live credentials are not needed for this deployment.

## Next Task
- Configure the Neon pooled/direct URLs, Google Web client ID, owner email, and three separate 64-character hex secrets directly in Render. Do not put secrets in chat or Git.
- Create/sync the Blueprint in Mural Production, deploy, then verify `/healthz`, `/readyz`, owner sign-in, and sanitized logs.
- After owner Google sign-in, import SIWC credentials from the laptop using the `web-admin` command documented in `docs/web-app.md`.

## Open Issues
- No live service exists, so database migrations, readiness, and owner sign-in have not been tested against Render or Neon.
- No PostgreSQL integration tests were run; the Docker build verifies production compilation only.
- An earlier separate pnpm build watcher may still report its pre-fix result; the later Docker build successfully ran both API and web builds after the allowlist fix.
