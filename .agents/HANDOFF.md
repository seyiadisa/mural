# Session Handoff

## Last Completed Task
- Confirmed the Render Blueprint sync for `ed8fc1c` succeeded. The two resulting service deploys ended `update_failed`; Render currently reports no running instances.
- Added sanitized startup stage and failure-code logging in `infra/render/container-entrypoint.mjs` (`3f9bfbe`, pushed to `origin/main`). It does not log raw exception messages or environment values. `node --check` and `git diff --check` passed.
- The deploy for `3f9bfbe` ended `update_failed`. Its logs show successful migration, `service_started`, and `GET /readyz` 200, then `container_startup_failed` at `reverse_proxy_start` with `EPERM`. A separate `HEAD unmatched` request returned `trusted_proxy_required`; it is not the startup failure.
- Added `chmod 0755` plus an executable check for the copied Caddy binary in `infra/render/Dockerfile` (`3c7edb3`). That deployment still failed at the same stage/code.
- Added a build-time `/usr/bin/caddy version` check as user `node` (`c399f50`). Render's build passed, but runtime still returned `EPERM` at `reverse_proxy_start`.
- Routed Caddy through a shell `exec` (`2b14f98`); runtime logged `/usr/bin/caddy: Operation not permitted` and exit code 126.
- Moved Caddy to `/usr/local/bin` (`4710c1e`); runtime logged the same `Operation not permitted`. The executable bit and path are not the cause.

## Current State
- Render Blueprint `mural-blueprint` is synced to `seyiadisa/mural` on `main`; service ID `srv-dbee9d7b9u1s739e3vmg`, region Frankfurt, URL `https://mural-ygi6.onrender.com`. The service has no running instances.
- Render project: `Mural` (`prj-dbec94gm7kps73de22c0`); Production environment: `evm-dbec94gm7kps73de22cg`. The CLI did not show this service attached to that environment.
- Neon is in `eu-central-1`. The user reports entering the required settings directly in Render; never copy secrets into Git or chat.
- Hosted voice remains off (`HOSTED_VOICE_EXPERIMENTAL=false`, lifetime cap `0`); GPT-Live credentials are not needed for this deployment.

## Next Task
- Propose a single-process Node service that serves the built SPA and API on the existing origin, removes Caddy, and trusts Render's overwritten `CF-Connecting-IP` only behind an explicit Render config flag. This preserves same-origin cookies and avoids executing Caddy in the container runtime.
- Obtain approval before changing the proxy trust boundary or making this multi-file architecture change. Then deploy and verify `/healthz`, `/readyz`, SPA assets, owner sign-in, and sanitized logs. Local Docker Desktop is not exposing its engine.
- After owner Google sign-in, import SIWC credentials from the laptop using the `web-admin` command documented in `docs/web-app.md`.

## Open Issues
- The Render service is not healthy and no running instance is reported.
- Render runtime denies execution of Caddy at both `/usr/bin/caddy` and `/usr/local/bin/caddy` (`Operation not permitted`), despite the successful non-root build check.
- Owner sign-in and the live Neon readiness path have not been verified end to end.
