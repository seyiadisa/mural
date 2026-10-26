# Set up your own Mural

This guide sets up the **private web app for one person**. It does not install the iPhone or Android apps.

You will use:

| Service | What it does |
| --- | --- |
| Render | Runs Mural and gives you a website address. |
| Neon | Stores your conversations, saved words, and settings. |
| Google Console | Lets you sign in to your Mural website. |
| Sign in with ChatGPT (SIWC) | Connects your eligible ChatGPT plan for text conversations. |

**Use the same email for your Mural owner account and your ChatGPT account.** This version checks that they match. Each person setting up Mural should use their own accounts, database, and secrets.

## 1. Get the code and tools

1. Create accounts at [GitHub](https://github.com), [Render](https://dashboard.render.com), and [Neon](https://console.neon.tech).
2. Install [Git](https://git-scm.com/downloads) and [Node.js](https://nodejs.org/en/download). Use Node.js **22.19 or newer**.
3. Open a terminal: PowerShell on Windows, or Terminal on macOS/Linux. Install the package manager used by this project:

   ```sh
   npm install --global pnpm@11.21.0
   ```

4. Open [the Mural repository](https://github.com/seyiadisa/mural) and click **Fork** to make your own copy.
5. Download your fork to your computer. Replace `YOUR-GITHUB-NAME` below:

   ```sh
   git clone https://github.com/YOUR-GITHUB-NAME/mural.git
   cd mural
   ```

Keep this terminal open. The `mural` folder is the **repository root** mentioned below.

## 2. Create the Neon database

1. In [Neon](https://console.neon.tech), create a project named `mural`.
2. Choose **AWS → Frankfurt (`eu-central-1`)**. The included Render configuration also uses Frankfurt.
3. Use a fresh database for Mural. The default database is fine in a new project.
4. Click **Connect**. Select the branch, database, and database-owner role for this installation.
5. Turn **Connection pooling on** and copy the full connection string. Save it privately as your **pooled URL**.
6. Turn **Connection pooling off** and copy that connection string. Save it as your **direct URL**.

Both URLs must point to the **same database**. Keep the TLS options Neon includes, such as `sslmode=require`. The pooled hostname contains `-pooler`; the direct hostname does not. [Neon's connection guide](https://neon.com/docs/connect/connection-pooling)

You do not need to create tables manually. Mural creates them during its first Render startup.

## 3. Set up Google sign-in

1. Open [Google Cloud Console](https://console.cloud.google.com) and create a project named `Mural`.
2. Open **Google Auth Platform**. If prompted, click **Get started** and enter an app name, support email, and contact email.
3. For a personal Gmail account, choose **External** as the audience. While the app is in **Testing**, add your owner email under **Audience → Test users**. [Google's consent-screen guide](https://developers.google.com/workspace/guides/configure-oauth-consent)
4. Open **Clients → Create client**. Choose **Web application** and name it `Mural Web`.
5. Create the client and copy its **Client ID**. It ends in `.apps.googleusercontent.com`.

You will add your website address after Render creates it. Mural uses Google's browser callback, so it does not need a Google client secret or an authorized redirect URI. The website belongs under **Authorized JavaScript origins**. [Google's web sign-in setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)

## 4. Deploy Mural on Render

First, generate three different private secrets. Run this command **three times**, saving each result under the name shown in the table below:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Each result should be 64 hexadecimal characters. Save them in a password manager; do not reuse one result for all three fields.

Then:

1. Open [Render](https://dashboard.render.com).
2. Choose **New → Blueprint**, connect GitHub, and select your Mural fork.
3. Select branch **main** and Blueprint path **render.yaml**. [Render's Blueprint instructions](https://render.com/docs/infrastructure-as-code)
4. Fill in the requested values:

   | Variable | Value to enter |
   | --- | --- |
   | `DATABASE_URL` | Your Neon **pooled URL**. |
   | `MURAL_MIGRATION_DATABASE_URL` | Your Neon **direct URL**. |
   | `GOOGLE_CLIENT_ID` | The Google web Client ID from step 3. |
   | `MURAL_WEB_OWNER_EMAIL` | The exact email you will use to sign in. |
   | `ACCOUNTS_HMAC_KEY` | Your first generated secret. |
   | `ACCOUNTS_PROXY_TOKEN` | Your second generated secret. |
   | `MURAL_SECRETS_ENCRYPTION_KEY` | Your third generated secret. Keep a safe backup of this one: it decrypts saved provider credentials. |

5. Review the service: **Docker**, **Frankfurt**, and the **Free** compute plan selected by the Blueprint. Then click **Deploy Blueprint**.
6. Wait for the service to show **Live**. Copy its website address, such as `https://your-mural.onrender.com`.

The Blueprint builds both the website and server. It also sets the website origins, browser Google Client ID, port, and health check. You do not need a separate static site, Render database, Docker installation, or custom build command.

Free services sleep after 15 minutes without traffic and can take about a minute to wake. Their local files are temporary; your Mural data stays in Neon. Review the [Free plan limits](https://render.com/docs/free) before relying on it for regular use.

## 5. Allow your Render address in Google

1. Return to **Google Cloud Console → Google Auth Platform → Clients → Mural Web**.
2. Under **Authorized JavaScript origins**, add your actual Render website address:

   ```text
   https://your-mural.onrender.com
   ```

   Use only `https://` and the hostname: no `/settings`, `/auth/callback`, or trailing slash.
3. Click **Save**. Allow a little time for Google's change to take effect.
4. Open your Mural website and click **Continue with Google**. Sign in with the email you entered as `MURAL_WEB_OWNER_EMAIL`.

**Complete this sign-in before connecting ChatGPT.** It creates the owner account that the SIWC import needs.

You can also open these two addresses, replacing the hostname with yours:

```text
https://your-mural.onrender.com/healthz
https://your-mural.onrender.com/readyz
```

The first should include `"ok":true`. The second should include `"database":true`.

## 6. Connect your ChatGPT plan with SIWC

Google signs you in to Mural. **SIWC is a separate sign-in that gives Mural permission to use your eligible ChatGPT plan for text.** It does not copy your ChatGPT conversations into Mural. Check [OpenAI's SIWC availability and requirements](https://developers.openai.com/siwc/token-sharing-open-source); this guide is for your own private installation, not a public paid service.

Run the following commands **on your computer**, where your browser is running. The local sign-in is then imported into the same Neon database Render uses. You do not need Codex, a Render shell, or SSH for this method. [OpenAI's remote-host guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)

### A. Prepare the local admin command

From the repository root:

```sh
cd services/api
pnpm install --frozen-lockfile
pnpm run build
```

Using a text editor, create a file named **`.env`** inside `services/api`. Put these three lines in it and replace the placeholders:

```dotenv
DATABASE_URL="PASTE_YOUR_NEON_POOLED_URL"
MURAL_WEB_OWNER_EMAIL="you@example.com"
MURAL_SECRETS_ENCRYPTION_KEY="PASTE_THE_EXACT_SAME_ENCRYPTION_KEY_AS_RENDER"
```

The database, owner email, and encryption key must match Render. Keep this file private; it is already excluded from Git. On Windows, check that your editor did not name it `.env.txt`.

Get this installation's host ID:

```sh
pnpm run web-admin host-id
```

Copy the full value beginning with `urn:uuid:`. Use this existing ID; do not generate a new one.

### B. Sign in locally

Return to the repository root:

```sh
cd ../..
node scripts/siwc-login.mjs "$HOME/.config/mural/siwc-credentials.json" "PASTE_THE_FULL_HOST_ID_HERE"
```

`$HOME` works in PowerShell and macOS/Linux terminals. The script creates the output folder if needed.

1. Keep the terminal running and open the URL it prints.
2. Sign in to ChatGPT with the **same email as your Mural owner account**.
3. Choose the workspace with your eligible plan and approve the requested plan access.
4. Wait for **Mural sign-in completed** in the browser and **Credentials saved locally** in the terminal.

The callback uses `127.0.0.1:1455` on your computer. You do not add this address to Google's configuration or to Render.

### C. Import the connection

Import promptly after sign-in, before the newly issued credentials expire:

```sh
cd services/api
pnpm run web-admin import-siwc "$HOME/.config/mural/siwc-credentials.json"
```

You should see:

```text
SIWC ChatGPT plan credentials installed for you@example.com.
```

The command encrypts the credentials in Neon. Render can use them immediately; no redeploy is needed. The server handles later token refreshes.

After a successful import, delete the temporary `siwc-credentials.json` file from your computer. Do not paste its contents into chat, GitHub, or Render environment fields.

## 7. Choose a model and start practising

1. Refresh your Mural website and open **Settings**.
2. Under **AI provider**, select **Sign in with ChatGPT**. Your connected email should appear.
3. Click **Load available models**, choose a model from the list, and click **Save AI settings**.
4. Under **Learning**, choose your learning language and meaning language, then click **Save preferences**.
5. Open **Talk**, start a conversation, and send a short message. This uses your ChatGPT plan allowance.

Changing the learning language starts a fresh practice screen. Previous conversations stay in **Journal**.

## Voice, backups, and updates

- **Voice:** this setup leaves voice disabled. SIWC covers text; hosted voice requires a separate OpenAI API key and additional server configuration. See [the detailed web guide](docs/web-app.md#voice-budget) before enabling it.
- **Backups:** use **Settings → Your archive → Download archive** for conversations and words. Also back up your Neon database and keep your encryption key separately. An archive does not include provider credentials.
- **Updates:** update your fork's `main` branch. With Render auto-deploy enabled, pushes to the linked branch deploy automatically. Before updating an installation with data, take a database/configuration backup; rolling back a Render image does not undo database migrations.

## If something goes wrong

| Problem | What to check |
| --- | --- |
| Render deploy fails | Open the service's deploy logs. Check the seven values from step 4, especially the direct migration URL. |
| Website is slow to open | A Free Render service may be waking up. Wait about a minute and retry. |
| `/readyz` does not show `database:true` | Check both Neon URLs point to the intended database and retain their TLS options. |
| Google reports `origin_mismatch` or an invalid origin | Add your exact Render HTTPS origin to the **Web application** client, save, wait, and reload. |
| Google denies access | Check the configured owner email and Google's Audience/Test users settings. |
| `web_owner_sign_in_required` during import | Sign in to the deployed Mural website with Google once, then retry the import. |
| `siwc_identity_mismatch` | Use the same email for ChatGPT, Google owner sign-in, Render, and the local `.env`. |
| `siwc_host_id_mismatch` | Read the host ID from this installation's database and repeat local sign-in with that ID. |
| `siwc_credentials_expired` | Repeat local sign-in and import the newly created file promptly. |
| SIWC is connected but requests fail | Confirm the local import used Render's exact encryption key and database. Check your ChatGPT plan access and selected model; reconnect if Mural asks. |
| Import prints a usage message | Use `pnpm run web-admin host-id` or `pnpm run web-admin import-siwc PATH`, without an extra `--`. |
| Voice is unavailable | Expected for this text-only setup. See the voice guide before changing its server flags. |

For Docker Compose, compatible API providers, and more operational detail, see [docs/web-app.md](docs/web-app.md).
