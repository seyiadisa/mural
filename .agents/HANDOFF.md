# Session Handoff

## Last Completed Task
- Implemented the private responsive web app, its owner-only API and PostgreSQL schema, the pnpm API migration, and deployment configuration for Google Cloud Run with Neon.
- Hosted voice remains disabled until configured. The web app's $10 estimate cap resets per UTC calendar month; it is an app-side cap, not a provider billing limit.
- Branch: `main`.
- Implementation commits: `9a0c734` (ignore rules), `19864ae` (project knowledge), `51531c1` (pnpm), `d481478` (web API), `6dda351` (web client), `3aad0a1` (deployment config).

## Current State
- The working tree is clean after the deployment documentation commit.
- No GCP resources, credentials, or provider keys were created. No services are running.
- `gcloud` is not installed in this workspace; Cloud Build submission and Cloud Run validation/deployment remain pending.

## Next Task
- Deploy using the steps in `docs/web-app.md`. Gather the GCP project ID and region, Neon pooled and direct connection URLs, Google OAuth web client ID, and owner email. Keep secret values out of chat.
- Create the Secret Manager entries and least-privilege service accounts, build images, apply the migration job, and deploy the private bootstrap service. Add its Cloud Run URL as the OAuth authorized JavaScript origin, then render and deploy the final service.
- After owner sign-in, use the laptop SIWC login flow and the one-off Secret Manager/Cloud Run Job import described in the guide. Keep hosted voice disabled unless separately configured.

## Open Issues
- Cloud Run templates still need validation against the user's GCP project; no Neon schema exists yet.
- Local Docker Compose remains unverified in this environment.
- SIWC is not configured, and the app is not connected to a ChatGPT account. No OpenAI API key is configured.
