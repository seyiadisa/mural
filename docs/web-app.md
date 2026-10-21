# Private Mural web app

The web client is a responsive React app served by the same HTTPS origin as the API. It stores web conversations and vocabulary in PostgreSQL, and is restricted to the Google account configured as the owner. Existing iOS and Android clients are not part of this release.

## Deploy on Google Cloud Run with Neon

The Cloud Run setup uses one multi-container service: Caddy receives public HTTPS traffic and forwards it to the API and web containers over Cloud Run's local container network. Cloud Run supports this sidecar pattern and starts dependent containers after their startup probes pass ([sidecar docs](https://docs.cloud.google.com/run/docs/deploying), [container start order](https://docs.cloud.google.com/run/docs/configuring/services/containers)). The API connects to Neon. A separate Cloud Run Job applies the database migrations. The deployment files are in `infra/gcp/`.

### Before deploying

1. Create a Google Cloud project, attach a billing account, install the Google Cloud CLI, and run `gcloud auth login`. Choose a Cloud Run region near your Neon region. The app can use the generated `run.app` URL; a custom domain is optional.
2. Create a Neon project and a dedicated database for this deployment. Save both connection strings privately:
   - Use the **pooled** connection string (host includes `-pooler`) for the running API.
   - Use the **direct** connection string for migrations.
   Both should require TLS. See [Neon's connection pooling guide](https://neon.com/docs/connect/connection-pooling).
3. Create a Google OAuth client of type **Web application**. The authorized JavaScript origin depends on the Cloud Run URL, which is returned after the first private deploy below; add it then. The app uses Google Identity Services and needs the authorized JavaScript origin.
4. Pick the exact Google email that will own the Mural account.
5. Create these Secret Manager secrets and add their values. Cloud Run reads them at startup ([secret configuration](https://docs.cloud.google.com/run/docs/configuring/services/secrets)). Do not commit them or paste them into chat:
   - `mural-neon-pooled-url`: the Neon pooled connection string.
   - `mural-neon-direct-url`: the Neon direct connection string.
   - `mural-accounts-hmac-key`, `mural-accounts-proxy-token`, and `mural-web-encryption-key`: three distinct random lowercase 64-character hex values. Generate each separately, for example with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
6. Create service accounts `mural-runtime` and `mural-migration`. Grant `roles/secretmanager.secretAccessor` to `mural-runtime` only on the pooled URL, HMAC key, proxy token, and encryption key. Grant it to `mural-migration` only on the direct URL. The migration job does not need the runtime credentials.

The manifests pin these secrets to version `1`. When rotating one, add a new Secret Manager version, update the matching `key` in `infra/gcp/service.yaml.template` or `job.yaml.template`, and deploy the new revision/job.

### Build and deploy

Run these from the repository root in PowerShell. Replace the example values with your project ID, region, Google OAuth client ID, and owner email. The commands build images remotely with Cloud Build, so Docker Desktop is not required on your laptop.

```powershell
$project = "YOUR_GCP_PROJECT_ID"
$region = "us-central1"
$googleClientId = "YOUR_WEB_CLIENT_ID.apps.googleusercontent.com"
$ownerEmail = "you@example.com"
$tag = Get-Date -Format "yyyyMMddHHmmss"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project $project
gcloud artifacts repositories create mural --repository-format=docker --location=$region --project=$project
gcloud builds submit . --project=$project --region=$region --config=infra/gcp/cloudbuild.yaml --substitutions="_REGION=$region,_TAG=$tag,_GOOGLE_CLIENT_ID=$googleClientId"
```

The Cloud Build service account needs `roles/artifactregistry.writer` on the `mural` repository. Render the manifests with no `-WebOrigin` first; this creates a **private** bootstrap service using a placeholder origin:

```powershell
.\infra\gcp\render-manifests.ps1 -ProjectId $project -Region $region -ImageTag $tag -GoogleClientId $googleClientId -OwnerEmail $ownerEmail
$manifestDir = Join-Path $env:TEMP "mural-gcp-$project"
gcloud run jobs replace (Join-Path $manifestDir "job.yaml") --project=$project --region=$region
gcloud run jobs execute mural-migrate --project=$project --region=$region --wait
gcloud run services replace (Join-Path $manifestDir "service.yaml") --project=$project --region=$region
$url = gcloud run services describe mural --project=$project --region=$region --format="value(status.url)"
$url
```

Add `$url` as an **Authorized JavaScript origin** on the Google OAuth web client. Then render and deploy the final public Cloud Run revision:

```powershell
.\infra\gcp\render-manifests.ps1 -ProjectId $project -Region $region -ImageTag $tag -GoogleClientId $googleClientId -OwnerEmail $ownerEmail -WebOrigin $url
gcloud run services replace (Join-Path $manifestDir "service.yaml") --project=$project --region=$region
Invoke-RestMethod "$url/readyz"
```

The public Cloud Run URL still requires Google sign-in with the configured owner email. The service scales to zero and is capped at one instance to limit idle usage and database connections. This is a fresh schema setup: these steps do not copy rows from a local Docker Compose database. If the local web app already contains data you want to keep, export and import that data separately before switching over.

The deploy keeps hosted voice paused: it sets `HOSTED_VOICE_EXPERIMENTAL=false` and does not configure `OPENAI_API_KEY`. The existing $10 monthly voice allowance remains in the app but is not spendable until voice is separately configured.

### Rollback and post-deploy setup

If the new revision has a problem, use Cloud Run's revision traffic controls to send traffic back to the previous revision. That rolls back the app revision, not database changes. Keep the Neon database and the `mural-web-encryption-key` secret: the key is needed to decrypt SIWC or compatible-provider credentials stored in that database. Back up both independently.

After the owner signs in once, connect SIWC using the laptop login flow below. Cloud Run does not provide an SSH host, so the existing Compose/SSH import command is not applicable; transfer the resulting credential file through a short-lived Secret Manager secret and run `web-admin.js import-siwc` as a one-off Cloud Run Job, then delete that temporary secret. Keep the credentials file private and do not place it in the repository.

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

This uses the local SIWC flow on your laptop, then sends its short-lived credential bundle to the server over SSH. It does not require the server to run Codex or to have an OpenAI API key. Run it from the cloned repository on your laptop with Node.js 22 or newer.

1. Sign in to Mural once so your owner account exists.
2. On the server, from `services/api`, get the stable host identity:

   ```sh
   docker compose run --rm api pnpm run web-admin -- host-id
   ```

3. On your laptop, run the login script and open the displayed URL in the browser where you use ChatGPT. Save the file outside the repository:

   ```sh
   node scripts/siwc-login.mjs "$HOME/.config/mural/siwc-credentials.json" "urn:uuid:PASTE-HOST-ID-HERE"
   ```

   The script listens only on `127.0.0.1:1455`, checks OAuth state and PKCE, and writes the credential file with user-only permissions where the OS supports them. The first sign-in registers a SIWC client for this Mural server; later sign-ins reuse it.

4. Transfer the file to the server with `scp`, then import it into the encrypted database. Replace the SSH host and paths:

   ```sh
   scp "$HOME/.config/mural/siwc-credentials.json" mural-host:/tmp/mural-siwc-credentials.json
   ssh mural-host 'chmod 600 /tmp/mural-siwc-credentials.json'
   ```

   On the server, from `services/api`, mount that file read-only for the one-time import:

   ```sh
   docker compose run --rm --user "$(id -u):$(id -g)" \
     -v /tmp/mural-siwc-credentials.json:/run/siwc.json:ro \
     api pnpm run web-admin -- import-siwc /run/siwc.json
   ```

5. Remove the temporary server copy after the importer succeeds. In Mural Settings, select **Sign in with ChatGPT**, load the available models, and explicitly save the model you want. SIWC supports Responses API requests; the server sends `store:false` and keeps the conversation history locally.

The server refreshes the access token and stores rotated credentials encrypted. A reconnect requires repeating the local sign-in and SSH transfer. For SIWC background and model limitations, see [OpenAI's SIWC documentation](https://developers.openai.com/siwc/token-sharing-open-source).

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
