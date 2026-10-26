import type { Database } from './db.js';
import { transaction } from './db.js';
import { ServiceError } from './errors.js';
import { decryptWebSecret, encryptWebSecret, type EncryptedWebSecret } from './web-secrets.js';

const TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
const API_ORIGIN = 'https://api.openai.com';
const REQUIRED_SCOPE = 'chatgpt.tokens.use.direct';

export interface SIWCCredentials {
  client_id: string;
  ext_agent_host_id: string;
  subject: string;
  email: string;
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scopes: string[];
  token_type: 'Bearer';
}

export interface SIWCStatus {
  connected: boolean;
  email: string | null;
  scopes: string[];
  expiresAt: string | null;
}

interface StoredSIWCCredentials extends EncryptedWebSecret {
  client_id: string;
  subject: string;
  email: string;
  scopes: string[];
  access_token_expires_at: Date;
}

async function boundedJSON(response: Response, maximumBytes = 512_000): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceError('ai_provider_unavailable', 502);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) throw new ServiceError('ai_provider_response_too_large', 502);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function siwcConnected(db: Database, accountID: string): Promise<SIWCStatus> {
  const row = (await db.query(`SELECT email,scopes,access_token_expires_at FROM web_siwc_credentials WHERE account_id=$1`, [accountID])).rows[0];
  return row ? { connected: true, email: row.email as string, scopes: row.scopes as string[],
    expiresAt: (row.access_token_expires_at as Date).toISOString() } : { connected: false, email: null, scopes: [], expiresAt: null };
}

export async function siwcAccessToken(db: Database, accountID: string): Promise<string> {
  return transaction(db, async sql => {
    const row = (await sql.query(`SELECT client_id,subject,email,scopes,access_token_expires_at,nonce,ciphertext,auth_tag
      FROM web_siwc_credentials WHERE account_id=$1 FOR UPDATE`, [accountID])).rows[0];
    if (!row) throw new ServiceError('siwc_not_connected', 503);
    const encrypted: EncryptedWebSecret = { nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag };
    const saved = decryptWebSecret<SIWCCredentials>(encrypted, 'siwc', accountID);
    if (!saved.scopes.includes(REQUIRED_SCOPE)) throw new ServiceError('siwc_plan_access_missing', 403);
    const expiresAt = new Date(row.access_token_expires_at as Date).getTime();
    if (expiresAt > Date.now() + 60_000) return saved.access_token;

    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: saved.client_id,
          refresh_token: saved.refresh_token, resource: 'https://api.openai.com/v1' }) });
    } catch { throw new ServiceError('siwc_refresh_unavailable', 503); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ServiceError(response.status === 400 || response.status === 401 ? 'siwc_reconnect_required' : 'siwc_refresh_unavailable', response.status === 400 || response.status === 401 ? 401 : 503); }
    let refreshed: any;
    try { refreshed = await boundedJSON(response, 64_000); } catch { throw new ServiceError('siwc_refresh_unavailable', 503); }
    if (typeof refreshed.access_token !== 'string' || typeof refreshed.refresh_token !== 'string' ||
        !Number.isSafeInteger(refreshed.expires_in) || refreshed.expires_in <= 0) throw new ServiceError('siwc_refresh_invalid', 503);
    const next: SIWCCredentials = { ...saved, access_token: refreshed.access_token, refresh_token: refreshed.refresh_token,
      ...(typeof refreshed.id_token === 'string' ? { id_token: refreshed.id_token } : {}),
      expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      scopes: typeof refreshed.scope === 'string' ? refreshed.scope.split(/\s+/).filter(Boolean) : saved.scopes };
    if (!next.scopes.includes(REQUIRED_SCOPE)) throw new ServiceError('siwc_plan_access_missing', 403);
    const encryptedNext = encryptWebSecret(next, 'siwc', accountID);
    await sql.query(`UPDATE web_siwc_credentials SET scopes=$2,access_token_expires_at=$3,nonce=$4,ciphertext=$5,auth_tag=$6,updated_at=now()
      WHERE account_id=$1`, [accountID, next.scopes, next.expires_at, encryptedNext.nonce, encryptedNext.ciphertext, encryptedNext.authTag]);
    return next.access_token;
  });
}

export async function siwcModels(db: Database, accountID: string): Promise<string[]> {
  const accessToken = await siwcAccessToken(db, accountID);
  let response: Response;
  try { response = await fetch(new URL('/v1/models', API_ORIGIN), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }); }
  catch { throw new ServiceError('ai_provider_unavailable', 502); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ServiceError('siwc_models_unavailable', 502); }
  const result = await boundedJSON(response, 2_097_152);
  if (!Array.isArray(result.models)) throw new ServiceError('siwc_models_invalid', 502);
  return result.models.filter((item: any) => item && item.visibility === 'list' && typeof item.slug === 'string')
    .map((item: any) => item.slug as string);
}

export async function storedSIWCCredentials(db: Database, accountID: string): Promise<SIWCCredentials> {
  const row = (await db.query(`SELECT nonce,ciphertext,auth_tag FROM web_siwc_credentials WHERE account_id=$1`, [accountID])).rows[0];
  if (!row) throw new ServiceError('siwc_not_connected', 503);
  return decryptWebSecret<SIWCCredentials>({ nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag }, 'siwc', accountID);
}
