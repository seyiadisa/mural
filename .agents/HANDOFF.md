# Session Handoff

## Last Completed Task
- Confirmed the Render Blueprint sync for `ed8fc1c` succeeded. The two resulting service deploys ended `update_failed`; Render currently reports no running instances.
- Added sanitized startup stage and failure-code logging in `infra/render/container-entrypoint.mjs` (`3f9bfbe`, pushed to `origin/main`). It does not log raw exception messages or environment values. `node --check` and `git diff --check` passed.
- The deploy for `3f9bfbe` ended `update_failed`. Its logs show successful migration, `service_started`, and `GET /readyz` 200, then `container_startup_failed` at `reverse_proxy_start` with `EPERM`. A separate `HEAD unmatched` request returned `trusted_proxy_required`; it is not the startup failure.
- Added `chmod 0755` plus an executable check for the copied Caddy binary in `infra/render/Dockerfile` (`3c7edb3`). That deployment still failed at the same stage/code.
- Added a build-time `/usr/bin/caddy version` check as user `node` (`c399f50`). Render's build passed, but runtime still returned `EPERM` at `reverse_proxy_start`.

## Current State
- Render Blueprint `mural-blueprint` is synced to `seyiadisa/mural` on `main`; service ID `srv-dbee9d7b9u1s739e3vmg`, region Frankfurt, URL `https://mural-ygi6.onrender.com`. The service has no running instances.
- Render project: `Mural` (`prj-dbec94gm7kps73de22c0`); Production environment: `evm-dbec94gm7kps73de22cg`. The CLI did not show this service attached to that environment.
- Neon is in `eu-central-1`. The user reports entering the required settings directly in Render; never copy secrets into Git or chat.
- Hosted voice remains off (`HOSTED_VOICE_EXPERIMENTAL=false`, lifetime cap `0`); GPT-Live credentials are not needed for this deployment.

## Next Task
- Write a plan and get user approval before changing process supervision or replacing Caddy. A small shell entrypoint that runs migrations, starts the API, then `exec`s Caddy as PID 1 may avoid the rejected Node child-process launch; verify signal handling and readiness.
- Deploy the selected fix, then verify `/healthz`, `/readyz`, owner sign-in, and sanitized logs. Local Docker Desktop is not exposing its engine.
- After owner Google sign-in, import SIWC credentials from the laptop using the `web-admin` command documented in `docs/web-app.md`.

## Open Issues
- The Render service is not healthy and no running instance is reported.
- Caddy cannot be started at runtime (`EPERM`) even though the image build sets `0755` and successfully runs `caddy version` as `node`.
- Owner sign-in and the live Neon readiness path have not been verified end to end.
