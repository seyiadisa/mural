import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../src/db.js';
import { encryptWebSecret } from '../src/web-secrets.js';
import { siwcModels, type SIWCCredentials } from '../src/web-siwc.js';
import { streamWebConversation } from '../src/web-ai.js';

test('SIWC model catalog uses visible slugs in provider order and accepts realistic catalog sizes', async t => {
  const previousKey = process.env.MURAL_SECRETS_ENCRYPTION_KEY;
  process.env.MURAL_SECRETS_ENCRYPTION_KEY = 'a'.repeat(64);
  try {
    const accountID = 'synthetic-account';
    const credentials: SIWCCredentials = { client_id: 'oaiapp_synthetic', ext_agent_host_id: 'urn:uuid:synthetic',
      subject: 'synthetic-subject', email: 'owner@example.test', id_token: 'synthetic-id-token',
      access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), scopes: ['chatgpt.tokens.use.direct'], token_type: 'Bearer' };
    const encrypted = encryptWebSecret(credentials, 'siwc', accountID);
    const sql = { async query(query: string, values?: unknown[]) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(query)) return { rows: [] };
      assert.match(query, /FROM web_siwc_credentials/);
      assert.deepEqual(values, [accountID]);
      return { rows: [{ nonce: encrypted.nonce, ciphertext: encrypted.ciphertext, auth_tag: encrypted.authTag,
        access_token_expires_at: new Date(credentials.expires_at) }] };
    }, release() {} };
    const db = { async connect() { return sql; } } as unknown as Database;
    let body: unknown = { models: [
      { slug: 'gpt-6-sol', visibility: 'list', metadata: 'x'.repeat(568_401) },
      { slug: 'hidden', visibility: 'hide' }, null, { id: 'wrong-field', visibility: 'list' },
      { slug: 'gpt-6-luna', visibility: 'list' }
    ] };
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), 'https://api.openai.com/v1/models');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer synthetic-access-token');
      return Response.json(body);
    });
    assert.deepEqual(await siwcModels(db, accountID), ['gpt-6-sol', 'gpt-6-luna']);
    body = { data: [{ id: 'gpt-6-luna', visibility: 'list' }] };
    await assert.rejects(siwcModels(db, accountID), { code: 'siwc_models_invalid' });
    body = { models: [], padding: 'x'.repeat(2_097_152) };
    await assert.rejects(siwcModels(db, accountID), { code: 'ai_provider_response_too_large' });
  } finally {
    if (previousKey === undefined) delete process.env.MURAL_SECRETS_ENCRYPTION_KEY;
    else process.env.MURAL_SECRETS_ENCRYPTION_KEY = previousKey;
  }
});

test('web conversations allow headerless SIWC streams while compatible providers remain strict', async t => {
  const previousKey = process.env.MURAL_SECRETS_ENCRYPTION_KEY;
  process.env.MURAL_SECRETS_ENCRYPTION_KEY = 'b'.repeat(64);
  try {
    const accountID = 'synthetic-account', conversationID = 'synthetic-conversation';
    const credential = encryptWebSecret({ access_token: 'synthetic-access-token', scopes: ['chatgpt.tokens.use.direct'] }, 'siwc', accountID);
    const compatible = encryptWebSecret({ apiKey: 'synthetic-compatible-key' }, 'compatible', accountID);
    let provider: 'siwc' | 'compatible' = 'siwc', inserted = 0;
    const query = async (text: string) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
      if (text.includes('SELECT c.id,c.language_id')) return { rows: [{ id: conversationID, language_id: 'nb-NO', meaning_language: 'English', theme_id: 'introductions' }] };
      if (text.includes('FROM web_ai_settings')) return { rows: [{ provider, model: 'gpt-6-luna', api_base: 'https://api.example.com/v1', api_style: 'responses', native_web_search: false }] };
      if (text.includes('FROM web_compatible_secrets')) return { rows: [{ nonce: compatible.nonce, ciphertext: compatible.ciphertext, auth_tag: compatible.authTag }], rowCount: 1 };
      if (text.includes('FROM web_siwc_credentials')) return { rows: [{ nonce: credential.nonce, ciphertext: credential.ciphertext,
        auth_tag: credential.authTag, access_token_expires_at: new Date(Date.now() + 3_600_000) }] };
      if (text.includes('SELECT role,content FROM web_messages')) return { rows: [{ role: 'user', content: 'Hei' }] };
      if (text.includes('INSERT INTO web_messages')) { inserted++; return { rows: [{ created_at: new Date() }] }; }
      assert.match(text, /^UPDATE web_conversations/); return { rows: [] };
    };
    const db = { query, async connect() { return { query, release() {} }; } } as unknown as Database;
    const events = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    let source = events({ type: 'response.output_text.delta', delta: 'Hei!' }) +
      events({ type: 'response.completed', response: { status: 'completed' } });
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), provider === 'siwc' ? 'https://api.openai.com/v1/responses' : 'https://api.example.com/v1/responses');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.stream, true); assert.equal(body.store, false);
      return new Response(new TextEncoder().encode(source));
    });
    const seen: string[] = [];
    const message = await streamWebConversation(db, accountID, conversationID, value => seen.push(value));
    assert.equal(message.content, 'Hei!'); assert.deepEqual(seen, ['Hei!']); assert.equal(inserted, 1);
    provider = 'compatible';
    await assert.rejects(streamWebConversation(db, accountID, conversationID, () => {}), /Invalid provider stream/);
    assert.equal(inserted, 1);
    provider = 'siwc'; source = events({ type: 'response.output_text.delta', delta: 'partial' });
    await assert.rejects(streamWebConversation(db, accountID, conversationID, () => {}), /without completion/);
    assert.equal(inserted, 1);
  } finally {
    if (previousKey === undefined) delete process.env.MURAL_SECRETS_ENCRYPTION_KEY;
    else process.env.MURAL_SECRETS_ENCRYPTION_KEY = previousKey;
  }
});
