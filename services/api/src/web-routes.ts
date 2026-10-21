import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './db.js';
import { transaction } from './db.js';
import { accountProfile, authenticate, bearerHash, createChallenge, exchangeIdentity, type AuthConfig, type verifyIdentity } from './auth.js';
import { ServiceError } from './errors.js';
import type { HostedVoice } from './hosted-voice.js';
import { appendMinuteEntry, lockMinuteWallet, minuteBalance } from './minutes.js';
import { availableWebModels, listCompatibleModels, normalizeCompatibleBase, streamWebConversation, supportedWebLanguage,
  supportedWebTheme, translateWebText, webAISettings } from './web-ai.js';
import { siwcConnected } from './web-siwc.js';
import { encryptWebSecret, webSecretsConfigured } from './web-secrets.js';
import { verifyIdentity as defaultIdentityVerifier } from './auth.js';

const SESSION_COOKIE = 'mural_web_session';
const WEB_VOICE_ALLOWANCE_MS = 12_000_000;
const MAX_ARCHIVE_BYTES = 10_000_000;
const meaningLanguages = new Set(['English','French','German','Spanish','Norwegian','Portuguese','Italian','Chinese (Simplified)',
  'Polish','Arabic','Ukrainian','Serbian (Latin)','Greek','Tagalog (Filipino)','Dutch','Russian']);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface WebRouteConfig {
  db: Database;
  auth: AuthConfig;
  ownerEmail?: string;
  origin: string;
  identityVerifier?: typeof verifyIdentity;
  hosted?: HostedVoice;
}

function objectBody(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) throw new ServiceError('invalid_request');
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ServiceError('invalid_request');
}
function string(value: unknown, max: number, code = 'invalid_request'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ServiceError(code);
  return value.trim();
}
function id(value: unknown): string {
  const text = string(value, 36); if (!uuidPattern.test(text)) throw new ServiceError('invalid_request'); return text.toLowerCase();
}
function safeTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new ServiceError('invalid_archive');
  return new Date(value).toISOString();
}
function cookieToken(request: FastifyRequest): string {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length > 4096) throw new ServiceError('sign_in_required', 401);
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1) throw new ServiceError('sign_in_required', 401);
  const token = values[0]!.slice(SESSION_COOKIE.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ServiceError('sign_in_required', 401);
  return token;
}
function setSessionCookie(reply: FastifyReply, token: string, origin: string) {
  const secure = new URL(origin).protocol === 'https:' ? '; Secure' : '';
  reply.header('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict${secure}`);
}
function clearSessionCookie(reply: FastifyReply, origin: string) {
  const secure = new URL(origin).protocol === 'https:' ? '; Secure' : '';
  reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`);
}
function requireSameOrigin(request: FastifyRequest, origin: string) {
  if (request.headers.origin !== origin) throw new ServiceError('invalid_origin', 403);
}
async function ownerAccount(config: WebRouteConfig, request: FastifyRequest): Promise<{ accountID: string; token: string }> {
  if (!config.ownerEmail) throw new ServiceError('web_owner_not_configured', 503);
  const token = cookieToken(request), accountID = await authenticate(config.db, `Bearer ${token}`);
  const profile = await accountProfile(config.db, `Bearer ${token}`);
  if (!profile.email || profile.email.toLowerCase() !== config.ownerEmail.trim().toLowerCase()) throw new ServiceError('owner_access_required', 403);
  return { accountID, token };
}

function periodStart(now = new Date()): string { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10); }
function millisecondsToPeriodEnd(now = new Date()): number {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(0, end - now.getTime());
}
async function ensureVoicePeriod(db: Database, accountID: string): Promise<{ periodStart: string; availableMilliseconds: number; reservedMilliseconds: number; usedMilliseconds: number }> {
  const current = periodStart();
  await transaction(db, async sql => {
    await sql.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [accountID]);
    const period = await sql.query('SELECT period_start FROM web_voice_periods WHERE account_id=$1 AND period_start=$2 FOR UPDATE', [accountID, current]);
    if (period.rowCount) return;
    const wallet = await lockMinuteWallet(sql, accountID);
    if (!wallet.sandboxReconciled) throw new ServiceError('voice_budget_reconciliation_required', 409);
    const available = Math.max(0, wallet.balance - wallet.reserved - wallet.sandbox);
    const topUp = Math.max(0, WEB_VOICE_ALLOWANCE_MS - available);
    if (topUp) await appendMinuteEntry(sql, accountID, `web-voice-grant:${accountID}:${current}`, 'gift', topUp, 0, 'funded');
    await sql.query('INSERT INTO web_voice_periods(account_id,period_start,granted_ms) VALUES($1,$2,$3)', [accountID, current, WEB_VOICE_ALLOWANCE_MS]);
  });
  await db.query(`DELETE FROM web_voice_sessions s WHERE s.account_id=$1 AND s.created_at < now()-interval '5 minutes'
    AND NOT EXISTS(SELECT 1 FROM hosted_sessions h WHERE h.account_id=s.account_id AND h.idempotency_key=s.idempotency_key)`, [accountID]);
  const usage = (await db.query(`SELECT
    COALESCE(sum(CASE WHEN h.id IS NOT NULL AND h.state='closed' THEN LEAST(s.reserved_ms,COALESCE(h.charged_ms,0)) ELSE 0 END),0) AS used_ms,
    COALESCE(sum(CASE WHEN h.id IS NULL OR h.state<>'closed' THEN s.reserved_ms ELSE 0 END),0) AS reserved_ms
    FROM web_voice_sessions s LEFT JOIN hosted_sessions h ON h.account_id=s.account_id AND h.idempotency_key=s.idempotency_key
    WHERE s.account_id=$1 AND s.period_start=$2`, [accountID,current])).rows[0];
  const balance = await minuteBalance(db, accountID, true);
  const usedMilliseconds=Number(usage.used_ms),reservedMilliseconds=Number(usage.reserved_ms);
  const monthlyRemaining=Math.max(0,WEB_VOICE_ALLOWANCE_MS-usedMilliseconds-reservedMilliseconds);
  return { periodStart: current, availableMilliseconds: Math.min(monthlyRemaining,balance.availableMilliseconds),
    reservedMilliseconds, usedMilliseconds };
}

async function reserveWebVoice(db:Database,accountID:string,key:string){
  const budget=await ensureVoicePeriod(db,accountID),current=budget.periodStart;
  return transaction(db,async sql=>{
    await sql.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[accountID]);
    const period=await sql.query('SELECT granted_ms FROM web_voice_periods WHERE account_id=$1 AND period_start=$2 FOR UPDATE',[accountID,current]);
    if(!period.rowCount)throw new ServiceError('voice_budget_reset_pending',409);
    await sql.query(`DELETE FROM web_voice_sessions s WHERE s.account_id=$1 AND s.created_at < now()-interval '5 minutes'
      AND NOT EXISTS(SELECT 1 FROM hosted_sessions h WHERE h.account_id=s.account_id AND h.idempotency_key=s.idempotency_key)`,[accountID]);
    const usage=(await sql.query(`SELECT
      COALESCE(sum(CASE WHEN h.id IS NOT NULL AND h.state='closed' THEN LEAST(s.reserved_ms,COALESCE(h.charged_ms,0)) ELSE 0 END),0) AS used_ms,
      COALESCE(sum(CASE WHEN h.id IS NULL OR h.state<>'closed' THEN s.reserved_ms ELSE 0 END),0) AS reserved_ms
      FROM web_voice_sessions s LEFT JOIN hosted_sessions h ON h.account_id=s.account_id AND h.idempotency_key=s.idempotency_key
      WHERE s.account_id=$1 AND s.period_start=$2`,[accountID,current])).rows[0];
    const wallet=await lockMinuteWallet(sql,accountID);
    if(!wallet.sandboxReconciled)throw new ServiceError('voice_budget_reconciliation_required',409);
    const walletAvailable=Math.max(0,wallet.balance-wallet.reserved-wallet.sandbox);
    const monthlyAvailable=Math.max(0,WEB_VOICE_ALLOWANCE_MS-Number(usage.used_ms)-Number(usage.reserved_ms));
    const maximum=Math.min(600_000,monthlyAvailable,walletAvailable,Math.max(0,millisecondsToPeriodEnd()-30_000));
    if(maximum<60_000)throw new ServiceError('voice_monthly_budget_reached',402);
    if((await sql.query('SELECT 1 FROM web_voice_sessions WHERE account_id=$1 AND idempotency_key=$2',[accountID,key])).rowCount)
      throw new ServiceError('live_request_already_created',409);
    await sql.query('INSERT INTO web_voice_sessions(account_id,period_start,idempotency_key,reserved_ms) VALUES($1,$2,$3,$4)',
      [accountID,current,key,maximum]);
    return {periodStart:current,maximum};
  });
}

function validateArchive(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value) || Buffer.byteLength(JSON.stringify(value)) > MAX_ARCHIVE_BYTES)
    throw new ServiceError('invalid_archive', 413);
  const archive = value as Record<string, unknown>;
  if (archive.format !== 'mural-web-archive' || archive.version !== 1 || !Array.isArray(archive.conversations) ||
      !Array.isArray(archive.vocabulary) || archive.conversations.length > 2000 || archive.vocabulary.length > 20_000)
    throw new ServiceError('invalid_archive');
  const preferences = archive.preferences as Record<string, unknown> | undefined;
  if (preferences && (!supportedWebLanguage(String(preferences.languageID)) || !meaningLanguages.has(String(preferences.meaningLanguage)) ||
      !supportedWebTheme(String(preferences.conversationTheme)) || !['system','light','dark'].includes(String(preferences.colorScheme))))
    throw new ServiceError('invalid_archive');
  const conversations = archive.conversations.map((item: any) => {
    if (!item || typeof item !== 'object' || !uuidPattern.test(item.id) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120 ||
        !supportedWebLanguage(item.languageID) || !supportedWebTheme(item.themeID) || !Array.isArray(item.messages) || item.messages.length > 10_000)
      throw new ServiceError('invalid_archive');
    return { id: item.id.toLowerCase(), title: item.title.trim(), languageID: item.languageID, themeID: item.themeID,
      createdAt: safeTimestamp(item.createdAt), updatedAt: safeTimestamp(item.updatedAt), messages: item.messages.map((message: any) => {
        if (!message || typeof message !== 'object' || !uuidPattern.test(message.id) || !['user','assistant'].includes(message.role) ||
            typeof message.content !== 'string' || !message.content.trim() || message.content.length > 20_000 ||
            (message.meaning !== null && message.meaning !== undefined && (typeof message.meaning !== 'string' || message.meaning.length > 4000)))
          throw new ServiceError('invalid_archive');
        return { id: message.id.toLowerCase(), role: message.role, content: message.content, meaning: message.meaning ?? null,
          createdAt: safeTimestamp(message.createdAt) };
      }) };
  });
  const vocabulary = archive.vocabulary.map((item: any) => {
    if (!item || typeof item !== 'object' || !uuidPattern.test(item.id) || !supportedWebLanguage(item.languageID) ||
        typeof item.phrase !== 'string' || !item.phrase.trim() || item.phrase.length > 500 || typeof item.meaning !== 'string' ||
        !item.meaning.trim() || item.meaning.length > 2000 || (item.note !== null && item.note !== undefined && typeof item.note !== 'string'))
      throw new ServiceError('invalid_archive');
    return { id: item.id.toLowerCase(), languageID: item.languageID, phrase: item.phrase.trim(), meaning: item.meaning.trim(),
      note: item.note ?? null, sourceConversationID: item.sourceConversationID ? id(item.sourceConversationID) : null,
      createdAt: safeTimestamp(item.createdAt) };
  });
  return { preferences, conversations, vocabulary };
}

export function registerWebRoutes(app: FastifyInstance, config: WebRouteConfig) {
  const { db } = config;
  const authRate = { config: { rateLimit: { max: 12, timeWindow: 60_000 } }, bodyLimit: 20_000 };
  app.get('/v1/web/auth/config', async () => ({ enabled: Boolean(config.ownerEmail && config.auth.googleClientID),
    googleClientID: config.auth.googleClientID ?? null }));
  app.post('/v1/web/auth/challenge', authRate, async (request, reply) => {
    requireSameOrigin(request, config.origin);
    if (!config.ownerEmail || !config.auth.googleClientID) throw new ServiceError('web_auth_not_configured', 503);
    if (Object.keys(objectBody(request)).length) throw new ServiceError('invalid_request');
    return createChallenge(db);
  });
  app.post('/v1/web/auth/exchange', authRate, async (request, reply) => {
    requireSameOrigin(request, config.origin);
    if (!config.ownerEmail || !config.auth.googleClientID) throw new ServiceError('web_auth_not_configured', 503);
    const body = objectBody(request); onlyKeys(body, ['idToken','challengeID']);
    const baseVerifier = config.identityVerifier ?? defaultIdentityVerifier;
    const ownerVerifier: typeof defaultIdentityVerifier = async (...args) => {
      const identity = await baseVerifier(...args);
      if (identity.provider !== 'google' || !identity.email || identity.email.toLowerCase() !== config.ownerEmail!.trim().toLowerCase())
        throw new ServiceError('owner_access_required', 403);
      return identity;
    };
    const session = await exchangeIdentity(db, 'google', string(body.idToken, 16_384), id(body.challengeID), config.auth, ownerVerifier);
    setSessionCookie(reply, session.accessToken, config.origin);
    return { signedIn: true, expiresInSeconds: session.expiresInSeconds };
  });
  app.get('/v1/web/auth/session', async request => {
    if (!config.ownerEmail) throw new ServiceError('web_owner_not_configured', 503);
    const { token } = await ownerAccount(config, request);
    const profile = await accountProfile(db, `Bearer ${token}`);
    return { signedIn: true, email: profile.email, createdAt: profile.createdAt };
  });
  app.post('/v1/web/auth/sign-out', authRate, async (request, reply) => {
    requireSameOrigin(request, config.origin);
    const { accountID,token } = await ownerAccount(config, request);
    await db.query('UPDATE auth_sessions SET revoked_at=now() WHERE account_id=$1 AND token_hash=$2 AND revoked_at IS NULL',
      [accountID,bearerHash(`Bearer ${token}`)]);
    clearSessionCookie(reply, config.origin); return { signedOut: true };
  });

  app.get('/v1/web/bootstrap', async request => {
    const { accountID } = await ownerAccount(config, request);
    const [preferences, conversations, vocabulary, aiSettings, siwc] = await Promise.all([
      db.query('SELECT language_id,meaning_language,conversation_theme,color_scheme FROM web_preferences WHERE account_id=$1', [accountID]),
      db.query(`SELECT c.id,c.title,c.language_id,c.theme_id,c.created_at,c.updated_at,
        (SELECT count(*) FROM web_messages m WHERE m.conversation_id=c.id AND m.account_id=c.account_id) AS message_count
        FROM web_conversations c WHERE c.account_id=$1 ORDER BY c.updated_at DESC LIMIT 200`, [accountID]),
      db.query('SELECT id,language_id,phrase,meaning,note,source_conversation_id,created_at FROM web_vocabulary WHERE account_id=$1 ORDER BY created_at DESC LIMIT 5000', [accountID]),
      webAISettings(db, accountID), siwcConnected(db, accountID)
    ]);
    const p = preferences.rows[0];
    const voiceEnabled = Boolean(config.hosted?.available && config.hosted.minuteFunded && config.hosted.publicMinuteAccess);
    let voice = { enabled: voiceEnabled, reason: voiceEnabled ? null : 'voice_provider_not_configured', periodStart: null as string | null,
      availableMilliseconds: 0, reservedMilliseconds: 0, usedMilliseconds: 0, limitUSD: 10 };
    if (voiceEnabled) {
      try { voice = { ...voice, ...await ensureVoicePeriod(db, accountID) }; }
      catch (error) { if (!(error instanceof ServiceError)) throw error; voice = { ...voice, enabled: false, reason: error.code }; }
    }
    return { preferences: p ? { languageID:p.language_id, meaningLanguage:p.meaning_language,
      conversationTheme:p.conversation_theme, colorScheme:p.color_scheme } : { languageID:'nb-NO', meaningLanguage:'English', conversationTheme:'introductions', colorScheme:'system' },
      conversations: conversations.rows.map(row => ({ id:row.id,title:row.title,languageID:row.language_id,themeID:row.theme_id,
        createdAt:(row.created_at as Date).toISOString(),updatedAt:(row.updated_at as Date).toISOString(),messageCount:Number(row.message_count) })),
      vocabulary: vocabulary.rows.map(row => ({ id:row.id,languageID:row.language_id,phrase:row.phrase,meaning:row.meaning,note:row.note,
        sourceConversationID:row.source_conversation_id,createdAt:(row.created_at as Date).toISOString() })),
      ai:{ ...aiSettings, siwcConnected:siwc.connected, siwcEmail:siwc.email, siwcScopeGranted:siwc.scopes.includes('chatgpt.tokens.use.direct'),
        secretsEncryptionConfigured:webSecretsConfigured() }, voice };
  });

  app.put('/v1/web/preferences', async (request, reply) => {
    requireSameOrigin(request, config.origin); const { accountID } = await ownerAccount(config, request);
    const body=objectBody(request); onlyKeys(body,['languageID','meaningLanguage','conversationTheme','colorScheme']);
    const languageID=string(body.languageID,20), meaningLanguage=string(body.meaningLanguage,40),
      conversationTheme=string(body.conversationTheme,40), colorScheme=string(body.colorScheme,10);
    if (!supportedWebLanguage(languageID) || !meaningLanguages.has(meaningLanguage) || !supportedWebTheme(conversationTheme) ||
        !['system','light','dark'].includes(colorScheme)) throw new ServiceError('invalid_learning_preferences');
    await db.query(`INSERT INTO web_preferences(account_id,language_id,meaning_language,conversation_theme,color_scheme)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id) DO UPDATE SET language_id=excluded.language_id,meaning_language=excluded.meaning_language,
      conversation_theme=excluded.conversation_theme,color_scheme=excluded.color_scheme,updated_at=now()`,
      [accountID,languageID,meaningLanguage,conversationTheme,colorScheme]);
    return { saved:true };
  });

  app.post('/v1/web/ai/settings', { bodyLimit: 8_000 }, async (request, reply) => {
    requireSameOrigin(request, config.origin); const { accountID } = await ownerAccount(config, request);
    const body=objectBody(request); onlyKeys(body,['provider','apiBase','model','apiStyle','nativeWebSearch','apiKey','clearApiKey']);
    if (body.provider!=='siwc' && body.provider!=='compatible') throw new ServiceError('invalid_ai_settings');
    if (body.apiStyle!==undefined && body.apiStyle!=='responses' && body.apiStyle!=='chat_completions') throw new ServiceError('invalid_ai_settings');
    if (body.nativeWebSearch!==undefined && typeof body.nativeWebSearch!=='boolean') throw new ServiceError('invalid_ai_settings');
    if (body.clearApiKey!==undefined && typeof body.clearApiKey!=='boolean') throw new ServiceError('invalid_ai_settings');
    const model=string(body.model,128,'invalid_ai_settings');
    const apiBase=body.apiBase===undefined?'https://api.openai.com/v1':normalizeCompatibleBase(string(body.apiBase,500,'invalid_ai_settings'));
    const apiStyle=(body.apiStyle as string | undefined) ?? 'responses';
    if (body.nativeWebSearch===true && apiStyle!=='responses') throw new ServiceError('search_requires_responses_api');
    if (body.provider==='siwc' && apiStyle!=='responses') throw new ServiceError('siwc_responses_only');
    const previous = await webAISettings(db, accountID);
    if (body.apiKey!==undefined) {
      const key=string(body.apiKey,2048,'invalid_ai_settings');
      if (/[\x00-\x20\x7f]/.test(key)) throw new ServiceError('invalid_ai_settings');
      if (!webSecretsConfigured()) throw new ServiceError('web_secrets_not_configured',503);
      const encrypted=encryptWebSecret({apiKey:key},'compatible',accountID);
      await db.query(`INSERT INTO web_compatible_secrets(account_id,nonce,ciphertext,auth_tag) VALUES($1,$2,$3,$4)
        ON CONFLICT(account_id) DO UPDATE SET nonce=excluded.nonce,ciphertext=excluded.ciphertext,auth_tag=excluded.auth_tag,updated_at=now()`,
        [accountID,encrypted.nonce,encrypted.ciphertext,encrypted.authTag]);
    } else if (body.clearApiKey===true) await db.query('DELETE FROM web_compatible_secrets WHERE account_id=$1',[accountID]);
    await db.query(`INSERT INTO web_ai_settings(account_id,provider,api_base,model,api_style,native_web_search)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id) DO UPDATE SET provider=excluded.provider,api_base=excluded.api_base,
      model=excluded.model,api_style=excluded.api_style,native_web_search=excluded.native_web_search,updated_at=now()`,
      [accountID,body.provider,apiBase,model,apiStyle,body.nativeWebSearch ?? false]);
    return { saved:true, previousProvider:previous.provider, settings:await webAISettings(db,accountID) };
  });

  app.get('/v1/web/ai/models', async request => {
    const {accountID}=await ownerAccount(config,request), settings=await webAISettings(db,accountID);
    if(settings.provider==='compatible') return {models:await listCompatibleModels(db,accountID)};
    return {models:await availableWebModels(db,accountID)};
  });

  app.post('/v1/web/conversations', async (request, reply) => {
    requireSameOrigin(request,config.origin); const {accountID}=await ownerAccount(config,request);
    const body=objectBody(request); onlyKeys(body,['languageID','themeID']);
    const prefs=(await db.query('SELECT language_id,conversation_theme FROM web_preferences WHERE account_id=$1',[accountID])).rows[0];
    const languageID=body.languageID===undefined?prefs?.language_id??'nb-NO':string(body.languageID,20);
    const themeID=body.themeID===undefined?prefs?.conversation_theme??'introductions':string(body.themeID,40);
    if(!supportedWebLanguage(languageID)||!supportedWebTheme(themeID)) throw new ServiceError('invalid_request');
    const created=await db.query(`INSERT INTO web_conversations(id,account_id,title,language_id,theme_id) VALUES($1,$2,$3,$4,$5)
      RETURNING id,title,language_id,theme_id,created_at,updated_at`,[randomUUID(),accountID,themesLabel(themeID),languageID,themeID]);
    const row=created.rows[0]; return {id:row.id,title:row.title,languageID:row.language_id,themeID:row.theme_id,createdAt:(row.created_at as Date).toISOString(),updatedAt:(row.updated_at as Date).toISOString(),messages:[]};
  });
  app.get('/v1/web/conversations/:id', async request => {
    const {accountID}=await ownerAccount(config,request), conversationID=id((request.params as {id:string}).id);
    const [conversation,messages]=await Promise.all([
      db.query('SELECT id,title,language_id,theme_id,created_at,updated_at FROM web_conversations WHERE id=$1 AND account_id=$2',[conversationID,accountID]),
      db.query('SELECT id,role,content,meaning,created_at FROM web_messages WHERE conversation_id=$1 AND account_id=$2 ORDER BY created_at,id',[conversationID,accountID])
    ]);
    const row=conversation.rows[0]; if(!row) throw new ServiceError('conversation_not_found',404);
    return {id:row.id,title:row.title,languageID:row.language_id,themeID:row.theme_id,createdAt:(row.created_at as Date).toISOString(),updatedAt:(row.updated_at as Date).toISOString(),
      messages:messages.rows.map(message=>({id:message.id,role:message.role,content:message.content,meaning:message.meaning,
        createdAt:(message.created_at as Date).toISOString()}))};
  });
  app.delete('/v1/web/conversations/:id', async (request, reply) => {
    requireSameOrigin(request,config.origin); const {accountID}=await ownerAccount(config,request), conversationID=id((request.params as {id:string}).id);
    const result=await db.query('DELETE FROM web_conversations WHERE id=$1 AND account_id=$2',[conversationID,accountID]);
    if(!result.rowCount) throw new ServiceError('conversation_not_found',404); return {deleted:true};
  });
  app.post('/v1/web/conversations/:id/respond', {bodyLimit:24_000,config:{rateLimit:{max:30,timeWindow:60_000}}}, async (request,reply) => {
    requireSameOrigin(request,config.origin); const {accountID}=await ownerAccount(config,request), conversationID=id((request.params as {id:string}).id);
    const body=objectBody(request); onlyKeys(body,['content']); const content=string(body.content,20_000);
    const conversation=(await db.query('SELECT id,title FROM web_conversations WHERE id=$1 AND account_id=$2',[conversationID,accountID])).rows[0];
    if(!conversation) throw new ServiceError('conversation_not_found',404);
    const messageCount=Number((await db.query('SELECT count(*) AS count FROM web_messages WHERE account_id=$1 AND conversation_id=$2',[accountID,conversationID])).rows[0].count);
    await db.query(`INSERT INTO web_messages(id,account_id,conversation_id,role,content) VALUES($1,$2,$3,'user',$4)`,[randomUUID(),accountID,conversationID,content]);
    if(messageCount===0) await db.query('UPDATE web_conversations SET title=$3,updated_at=now() WHERE id=$1 AND account_id=$2',[conversationID,accountID,content.slice(0,110)]);
    else await db.query('UPDATE web_conversations SET updated_at=now() WHERE id=$1 AND account_id=$2',[conversationID,accountID]);
    reply.hijack(); reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','Connection':'keep-alive'});
    const controller=new AbortController(); reply.raw.on('close',()=>{if(!reply.raw.writableEnded) controller.abort();});
    const emit=(event:unknown)=>{if(!reply.raw.destroyed)reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);};
    try { const message=await streamWebConversation(db,accountID,conversationID,text=>emit({type:'delta',text}),controller.signal); emit({type:'done',message}); }
    catch(error) { const code=error instanceof ServiceError?error.code:'ai_provider_unavailable'; emit({type:'error',code}); }
    finally { if(!reply.raw.destroyed)reply.raw.end(); }
  });
  app.post('/v1/web/conversations/:id/messages', async (request,reply) => {
    requireSameOrigin(request,config.origin); const {accountID}=await ownerAccount(config,request), conversationID=id((request.params as {id:string}).id);
    const body=objectBody(request); onlyKeys(body,['role','content']);
    if(body.role!=='user'&&body.role!=='assistant') throw new ServiceError('invalid_request'); const content=string(body.content,20_000);
    const result=await db.query(`INSERT INTO web_messages(id,account_id,conversation_id,role,content)
      SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM web_conversations WHERE id=$3 AND account_id=$2) RETURNING id,created_at`,
      [randomUUID(),accountID,conversationID,body.role,content]);
    if(!result.rowCount) throw new ServiceError('conversation_not_found',404);
    await db.query('UPDATE web_conversations SET updated_at=now() WHERE id=$1 AND account_id=$2',[conversationID,accountID]);
    return {id:result.rows[0].id,role:body.role,content,meaning:null,createdAt:(result.rows[0].created_at as Date).toISOString()};
  });
  app.post('/v1/web/conversations/:id/messages/:messageId/meaning', {config:{rateLimit:{max:30,timeWindow:60_000}}}, async (request,reply) => {
    requireSameOrigin(request,config.origin); const {accountID}=await ownerAccount(config,request);
    if(Object.keys(objectBody(request)).length) throw new ServiceError('invalid_request');
    const conversationID=id((request.params as {id:string}).id), messageID=id((request.params as {messageId:string}).messageId);
    const row=(await db.query(`SELECT m.content,c.language_id FROM web_messages m JOIN web_conversations c ON c.id=m.conversation_id AND c.account_id=m.account_id
      WHERE m.id=$1 AND m.conversation_id=$2 AND m.account_id=$3`,[messageID,conversationID,accountID])).rows[0];
    if(!row) throw new ServiceError('message_not_found',404);
    const meaning=await translateWebText(db,accountID,row.language_id,row.content);
    await db.query('UPDATE web_messages SET meaning=$2 WHERE id=$1 AND account_id=$3',[messageID,meaning,accountID]);
    return {messageID,meaning};
  });

  app.post('/v1/web/vocabulary', async (request,reply) => {
    requireSameOrigin(request,config.origin); const {accountID}=await ownerAccount(config,request);
    const body=objectBody(request); onlyKeys(body,['languageID','phrase','meaning','note','sourceConversationID']);
    const languageID=string(body.languageID,20),phrase=string(body.phrase,500),meaning=string(body.meaning,2000);
    const note=body.note===undefined||body.note===null?null:string(body.note,2000);
    const source=body.sourceConversationID===undefined||body.sourceConversationID===null?null:id(body.sourceConversationID);
    if(!supportedWebLanguage(languageID)) throw new ServiceError('invalid_request');
    const result=await db.query(`INSERT INTO web_vocabulary(id,account_id,language_id,phrase,meaning,note,source_conversation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at`,[randomUUID(),accountID,languageID,phrase,meaning,note,source]);
    return {id:result.rows[0].id,languageID,phrase,meaning,note,sourceConversationID:source,createdAt:(result.rows[0].created_at as Date).toISOString()};
  });
  app.delete('/v1/web/vocabulary/:id', async (request,reply) => {
    requireSameOrigin(request,config.origin); const {accountID}=await ownerAccount(config,request), vocabularyID=id((request.params as {id:string}).id);
    const result=await db.query('DELETE FROM web_vocabulary WHERE id=$1 AND account_id=$2',[vocabularyID,accountID]);
    if(!result.rowCount) throw new ServiceError('vocabulary_not_found',404); return {deleted:true};
  });

  app.get('/v1/web/archive/export', async request => {
    const {accountID}=await ownerAccount(config,request);
    const [prefs,conversations,vocabulary]=await Promise.all([
      db.query('SELECT language_id,meaning_language,conversation_theme,color_scheme FROM web_preferences WHERE account_id=$1',[accountID]),
      db.query('SELECT id,title,language_id,theme_id,created_at,updated_at FROM web_conversations WHERE account_id=$1 ORDER BY created_at,id',[accountID]),
      db.query('SELECT id,language_id,phrase,meaning,note,source_conversation_id,created_at FROM web_vocabulary WHERE account_id=$1 ORDER BY created_at,id',[accountID])
    ]);
    const messages=await db.query(`SELECT id,conversation_id,role,content,meaning,created_at FROM web_messages WHERE account_id=$1 ORDER BY conversation_id,created_at,id`,[accountID]);
    const grouped=new Map<string,any[]>(); for(const row of messages.rows){const list=grouped.get(row.conversation_id)??[];list.push({id:row.id,role:row.role,content:row.content,meaning:row.meaning,createdAt:(row.created_at as Date).toISOString()});grouped.set(row.conversation_id,list);}
    const pref=prefs.rows[0];
    return {format:'mural-web-archive',version:1,exportedAt:new Date().toISOString(),
      preferences:pref?{languageID:pref.language_id,meaningLanguage:pref.meaning_language,conversationTheme:pref.conversation_theme,colorScheme:pref.color_scheme}:null,
      conversations:conversations.rows.map(row=>({id:row.id,title:row.title,languageID:row.language_id,themeID:row.theme_id,
        createdAt:(row.created_at as Date).toISOString(),updatedAt:(row.updated_at as Date).toISOString(),messages:grouped.get(row.id)??[]})),
      vocabulary:vocabulary.rows.map(row=>({id:row.id,languageID:row.language_id,phrase:row.phrase,meaning:row.meaning,note:row.note,
        sourceConversationID:row.source_conversation_id,createdAt:(row.created_at as Date).toISOString()}))};
  });
  app.post('/v1/web/archive/import', {bodyLimit:MAX_ARCHIVE_BYTES+4096}, async (request,reply) => {
    requireSameOrigin(request,config.origin); const {accountID}=await ownerAccount(config,request);
    const body=objectBody(request); onlyKeys(body,['archive','mode']);
    if(body.mode!=='merge'&&body.mode!=='replace') throw new ServiceError('invalid_request');
    const archive=validateArchive(body.archive);
    await transaction(db,async sql=>{
      if(body.mode==='replace'){
        await sql.query('DELETE FROM web_vocabulary WHERE account_id=$1',[accountID]);
        await sql.query('DELETE FROM web_conversations WHERE account_id=$1',[accountID]);
        await sql.query('DELETE FROM web_preferences WHERE account_id=$1',[accountID]);
      }
      const p=archive.preferences;
      if(p) await sql.query(`INSERT INTO web_preferences(account_id,language_id,meaning_language,conversation_theme,color_scheme)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id) DO NOTHING`,[accountID,p.languageID,p.meaningLanguage,p.conversationTheme,p.colorScheme]);
      for(const conversation of archive.conversations){
        await sql.query(`INSERT INTO web_conversations(id,account_id,title,language_id,theme_id,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,[conversation.id,accountID,conversation.title,conversation.languageID,conversation.themeID,conversation.createdAt,conversation.updatedAt]);
        for(const message of conversation.messages) await sql.query(`INSERT INTO web_messages(id,account_id,conversation_id,role,content,meaning,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,[message.id,accountID,conversation.id,message.role,message.content,message.meaning,message.createdAt]);
      }
      for(const item of archive.vocabulary) await sql.query(`INSERT INTO web_vocabulary(id,account_id,language_id,phrase,meaning,note,source_conversation_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,[item.id,accountID,item.languageID,item.phrase,item.meaning,item.note,item.sourceConversationID,item.createdAt]);
    });
    return {imported:true,conversations:archive.conversations.length,vocabulary:archive.vocabulary.length,mode:body.mode};
  });

  app.get('/v1/web/voice/budget', async request => {
    const {accountID}=await ownerAccount(config,request);
    if(!config.hosted?.available||!config.hosted.minuteFunded||!config.hosted.publicMinuteAccess)
      return {enabled:false,reason:'voice_provider_not_configured',limitUSD:10};
    return {enabled:true,limitUSD:10,rateUSDPerMinute:0.05,minutesToPeriodEnd:millisecondsToPeriodEnd(),...await ensureVoicePeriod(db,accountID)};
  });
  app.post('/v1/web/live/sessions', {bodyLimit:80_000,config:{rateLimit:{max:8,timeWindow:60_000}}}, async (request,reply) => {
    requireSameOrigin(request,config.origin); const {accountID}=await ownerAccount(config,request);
    if(!config.hosted?.available||!config.hosted.minuteFunded||!config.hosted.publicMinuteAccess) throw new ServiceError('hosted_voice_not_ready',503);
    const body=objectBody(request); onlyKeys(body,['sdp','languageID','history']);
    const languageID=string(body.languageID,20); if(!supportedWebLanguage(languageID)) throw new ServiceError('invalid_language');
    if(!Array.isArray(body.history)||body.history.length>40||Buffer.byteLength(JSON.stringify(body.history))>6000) throw new ServiceError('invalid_live_context');
    const preferences=(await db.query('SELECT conversation_theme,meaning_language FROM web_preferences WHERE account_id=$1',[accountID])).rows[0];
    const themeID=(preferences?.conversation_theme as string | undefined)??'introductions';
    const themePrompt=themesLabel(themeID);
    const instructions=`You are Mural, a warm language conversation partner. Begin naturally with a short greeting and one simple question. Adapt pace and sentence length to the learner. Accept replies in any language. Make a meaningful recurring correction noticeable with a brief recast. Ask at most one relevant question and leave space for the learner. Use only ${languageID}. Scenario: ${themePrompt}. If the learner asks for a meaning, explain briefly in ${(preferences?.meaning_language as string | undefined)??'English'}.`;
    const key=request.headers['idempotency-key']; if(typeof key!=='string'||key.length<8||key.length>128) throw new ServiceError('idempotency_key_required');
    const claim=await reserveWebVoice(db,accountID,key);
    try {
      const session=await config.hosted.create(accountID,key,string(body.sdp,65_536),languageID,{instructions,history:body.history},claim.maximum,'live');
      const actual=session.reservedMilliseconds;
      if(typeof actual==='number'&&Number.isSafeInteger(actual)&&actual>=15_000&&actual<=claim.maximum)
        await db.query('UPDATE web_voice_sessions SET reserved_ms=$3 WHERE account_id=$1 AND idempotency_key=$2',[accountID,key,actual]);
      return session;
    } catch(error) {
      try {
        const exists=await db.query('SELECT id FROM hosted_sessions WHERE account_id=$1 AND idempotency_key=$2',[accountID,key]);
        if(!exists.rowCount)await db.query('DELETE FROM web_voice_sessions WHERE account_id=$1 AND idempotency_key=$2',[accountID,key]);
      } catch { /* Preserve the conservative monthly reservation until the next budget reconciliation. */ }
      throw error;
    }
  });
  app.get('/v1/web/live/sessions/:id',async request=>{
    const {accountID}=await ownerAccount(config,request); if(!config.hosted) throw new ServiceError('hosted_voice_not_ready',503);
    return config.hosted.status(accountID,id((request.params as {id:string}).id));
  });
  app.post('/v1/web/live/sessions/:id/close',{bodyLimit:1024},async(request,reply)=>{
    requireSameOrigin(request,config.origin);const {accountID}=await ownerAccount(config,request);
    if(!config.hosted)throw new ServiceError('hosted_voice_not_ready',503);if(Object.keys(objectBody(request)).length)throw new ServiceError('invalid_request');
    return config.hosted.close(accountID,id((request.params as {id:string}).id));
  });
}

function themesLabel(themeID:string):string {
  return ({coffee:'A coffee?',weekend:'The weekend',walk:'A little walk',dinner:'Dinner plans',introductions:'Nice to meet you',groceries:'At the market',
    travel:'Next stop',home:'A place of your own',friends:'New friends',work:'Monday morning',weather:'Rain again?',cabin:'A weekend away',
    music:'On repeat',film:'One more episode',books:'Between the pages',design:'Good things',technology:'What comes next',travelstories:'Somewhere else',
    restaurant:'A table for two',neighbours:'Next door',traditions:'Everyday customs',opinions:'What do you think?',future:'A year from now',today:'The world today'} as Record<string,string>)[themeID] ?? 'Nice to meet you';
}
