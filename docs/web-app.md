# Private Mural web app

The web client is a responsive React app served by the same HTTPS origin as the API. It stores web conversations and vocabulary in PostgreSQL, and is restricted to the Google account configured as the owner. Existing iOS and Android clients are not part of this release.

## Deploy on Render with Neon

The Render deployment is one Docker Web Service. Fastify serves the built React app and API from the same process and origin, preserving same-origin cookies. Render terminates public HTTPS. The container applies pending PostgreSQL migrations before starting Fastify. Deployment files are in `infra/render/` and `render.yaml`.

### Before creating the Render service

1. Create a Neon project and dedicated database. Save both connection strings privately: use the **pooled** URL (host includes `-pooler`) for `DATABASE_URL`, and the **direct** URL for `MURAL_MIGRATION_DATABASE_URL`. Both should require TLS. See [Neon's connection pooling guide](https://neon.com/docs/connect/connection-pooling).
2. Neon is in AWS `eu-central-1` (Frankfurt); `render.yaml` sets the Render service region to `frankfurt` to keep the app close to the database. Render does not allow changing a service's region after creation, so keep this setting for the first Blueprint sync.
3. Create a Google OAuth client of type **Web application**. Add the Render service URL as an authorized JavaScript origin after the first deploy.
4. Pick the exact Google email that will own the Mural account.
5. Connect your GitHub account to Render and create a Blueprint from this repository's `render.yaml`. The Blueprint asks for private values instead of storing them in Git. Keep these values private.
6. When prompted, provide `DATABASE_URL` (pooled Neon URL), `MURAL_MIGRATION_DATABASE_URL` (direct Neon URL), `GOOGLE_CLIENT_ID`, and `MURAL_WEB_OWNER_EMAIL`. Create three distinct random lowercase 64-character hex secrets for `ACCOUNTS_HMAC_KEY`, `ACCOUNTS_PROXY_TOKEN`, and `MURAL_SECRETS_ENCRYPTION_KEY`. Generate each separately with:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

The Blueprint uses `RENDER_EXTERNAL_URL` for `PUBLIC_ORIGIN` and `MURAL_WEB_ORIGIN`, and reuses `GOOGLE_CLIENT_ID` for the browser build. Fastify listens on Render's `PORT` (default `10000`) and serves the SPA fallback plus static assets from `/app/web`. The Blueprint sets `MURAL_TRUST_RENDER_EDGE=true`, which allows network admission to use Render's edge-supplied `CF-Connecting-IP`; that header is ignored unless this flag is enabled ([Render client IP guidance](https://render.com/articles/host-pocketbase-on-render)).

The default Blueprint uses Render's Free plan. Free web services sleep after 15 minutes without traffic, can take about a minute to wake, have an ephemeral filesystem, and are intended for hobby use rather than production. Mural stores data in Neon, not the container filesystem. Free services do not support pre-deploy commands or one-off jobs, so the container runs the idempotent migration runner on each start. See [Render's Free service limits](https://render.com/docs/free) and [Docker deploy documentation](https://render.com/docs/docker).

### First deploy and verification

After the Blueprint creates the service, add its `https://<service>.onrender.com` URL to the Google OAuth client's **Authorized JavaScript origins**. This OAuth Console change does not require a container rebuild. Once it takes effect, sign in with the configured owner email and check:

```text
https://<service>.onrender.com/healthz
https://<service>.onrender.com/readyz
```

`/healthz` checks the app process. `/readyz` also checks Neon. This is a fresh database setup; it does not copy rows from a local Docker Compose database. Export and import local web data separately if you already have records to keep.

Hosted voice remains paused: the Blueprint sets `HOSTED_VOICE_EXPERIMENTAL=false` and does not configure `OPENAI_API_KEY`. The $10 monthly voice allowance remains unavailable until voice is separately configured.

### Rollback

Use Render's deploy history to roll back to a previous application image. That rolls back the image, not database migrations. Keep the Neon database and `MURAL_SECRETS_ENCRYPTION_KEY`; the key decrypts SIWC or compatible-provider credentials stored there. Back them up independently. The Cloud Run templates remain in `infra/gcp/` as a reference.

## Self-host with Docker Compose

1. Point a domain's DNS `A`/`AAAA` record at a Linux server with Docker Compose v2. Use a fresh database for a new Mural installation.
2. Clone your Mural fork on the server and enter `services/api`.
3. Copy `.env.example` to `.env`, then set:
   - `API_DOMAIN` to the DNS name.
   - `POSTGRES_PASSWORD` to a fresh 48-character hexadecimal value, for example `openssl rand -hex 24`.
   - `MURAL_WEB_OWNER_EMAIL` to the Google account you will use to sign in.
   - `GOOGLE_CLIENT_ID` to a Google OAuth **Web application** client ID. Add `https://<API_DOMAIN>` as its authorized JavaScript origin.
   - `ACCOUNTS_HMAC_KEY`, `ACCOUNTS_PROXY_TOKEN`, and `MURAL_SECRETS_ENCRYPTION_KEY` to separate 32-byte hex values (`openssl rand -hex 32` for each). The last value encrypts provider credentials in PostgreSQL; it is an app encryption key, not an OpenAI API key.
   - Leave `OPENAI_API_KEY` blank if you do not want hosted voice enabled yet. It is optional; the browser never receives it.
4. Start the stack with `docker compose up -d --build`. Caddy obtains TLS certificates for `API_DOMAIN`; PostgreSQL data and Caddy certificates are stored in named Docker volumes.
5. Sign in at `https://<API_DOMAIN>` using the exact owner Google account. `/readyz` should return a ready database response.

For local development, use `MURAL_WEB_ORIGIN=http://localhost:5173`, authorize `http://localhost:5173` as a Google JavaScript origin, keep `ACCOUNTS_ALLOW_LOCAL_LOOPBACK=true`, run the API from `services/api`, and run the web client from `apps/web`. Compose overrides the local origin and disables loopback auth admission.

Keep `.env`, database dumps, and OAuth credential files private. The API encryption key must be backed up separately from PostgreSQL: without it, encrypted provider credentials cannot be recovered. Do not commit `.env`.

### Sign in with your ChatGPT plan (optional)

This uses the local SIWC flow on your laptop. Render does not need to run Codex or have an OpenAI API key. Run these commands from the cloned repository on your laptop with Node.js 22 or newer.

1. Sign in to Mural once so your owner account exists.
2. On your laptop, create `services/api/.env` with the Neon pooled `DATABASE_URL`, `MURAL_WEB_OWNER_EMAIL`, and the same `MURAL_SECRETS_ENCRYPTION_KEY` used by Render. This file is gitignored; keep it private.
3. From `services/api`, install dependencies, build the admin command, and get the stable host identity:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run build
   pnpm run web-admin -- host-id
   ```

4. From the repository root, run the login script and open the displayed URL in the browser where you use ChatGPT. Save the file outside the repository:

   ```sh
   node scripts/siwc-login.mjs "$HOME/.config/mural/siwc-credentials.json" "urn:uuid:PASTE-HOST-ID-HERE"
   ```

   The script listens only on `127.0.0.1:1455`, checks OAuth state and PKCE, and writes the credential file with user-only permissions where the OS supports them. The first sign-in registers a SIWC client for this Mural server; later sign-ins reuse it.

5. From `services/api`, import the local file into Neon. Replace the path with the location you chose above:

   ```sh
   pnpm run web-admin -- import-siwc "$HOME/.config/mural/siwc-credentials.json"
   ```

6. Remove the local credential file after import succeeds. In Mural Settings, select **Sign in with ChatGPT**, load the available models, and explicitly save the model you want. SIWC supports Responses API requests; the server sends `store:false` and keeps conversation history locally.

The server refreshes access tokens and stores rotated credentials encrypted. A reconnect requires repeating the local sign-in and import. For SIWC background and model limitations, see [OpenAI's SIWC documentation](https://developers.openai.com/siwc/token-sharing-open-source).

### Optional OpenAI-compatible text provider

Open Mural Settings, select **OpenAI-compatible API**, enter the provider's HTTPS API base and model, choose Responses or Chat Completions, enter its key, and save. The key is encrypted on the server and is never returned to the browser. Remote provider URLs must use HTTPS; only HTTP loopback is allowed for local development, and literal non-loopback IP addresses are rejected. Requests go only to the explicitly selected provider. Native web search is sent only when enabled and supported by that provider.

## Voice budget

Voice stays unavailable until the server has `OPENAI_API_KEY` and `HOSTED_VOICE_EXPERIMENTAL=true`. Set the key only in the host environment; it is used by the server for the configurable Live model (`MURAL_LIVE_MODEL`, default `gpt-live-1`). The app allows up to 200 minutes of reserved/charged connected time per **UTC calendar month**, based on the repository's current $0.05/minute voice rate; the monthly counter is separate from any existing minute balance and unused allowance does not carry over. Each call is limited to the lesser of ten minutes and the remaining monthly allowance. New calls stop at least 30 seconds before the UTC month boundary so setup time cannot move a reservation into the next period. Usage is reserved before the provider call and reconciled from durable session records.

OpenAI billing and the app's duration-based estimate can differ if provider pricing changes. The cap controls app-admitted connected time at the checked-in rate; it is not a provider-side spend limit. Review `services/api/src/pricing.ts` when updating voice pricing, and do not enable voice until its account-side billing controls are set as desired.

## Backups

Download a portable conversation and vocabulary archive from **Settings → Your archive**. That archive does not contain credentials or account sessions.

For a full self-host backup, take a private PostgreSQL dump and back up the encryption key separately:

```sh
mkdir -p backups
chmod 700 backups
docker compose exec -T database pg_dump -U mural -d mural --format=custom > "backups/mural-$(date -u +%Y%m%dT%H%M%SZ).dump"
chmod 600 backups/*.dump
```

Store database backups and the encryption key in a protected location. Test restoration only into an isolated database; a full database restore replaces the target database contents.
