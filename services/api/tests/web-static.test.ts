import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createApp } from '../src/app.js';
import type { Database } from '../src/db.js';

test('web fallback serves static assets and SPA routes without swallowing API 404s', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mural-web-static-'));
  const outsideName = `${root.split(sep).at(-1)}-outside.txt`;
  const outside = join(tmpdir(), outsideName);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Mural shell</title>');
  await writeFile(join(root, 'assets', 'index-12345678.js'), 'console.log("asset");');
  await writeFile(outside, 'private');
  const db = { query: async () => { throw new Error('Static requests must not use the database.'); } } as unknown as Database;
  const app = createApp({ db, auth: {}, web: { origin: 'http://localhost:8080', staticRoot: root } });
  try {
    const page = await app.inject({ url: '/practice/spanish' });
    assert.equal(page.statusCode, 200);
    assert.equal(page.body, '<!doctype html><title>Mural shell</title>');
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-cache');
    assert.equal(page.headers['content-security-policy']?.includes("default-src 'self'"), true);
    assert.equal(page.headers['strict-transport-security'], 'max-age=31536000');

    const asset = await app.inject({ url: '/assets/index-12345678.js' });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.body, 'console.log("asset");');
    assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');

    const head = await app.inject({ method: 'HEAD', url: '/' });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], String((await readFile(join(root, 'index.html'))).byteLength));

    const api404 = await app.inject({ url: '/v1/does-not-exist' });
    assert.equal(api404.statusCode, 404);
    assert.deepEqual(api404.json(), { error: { code: 'not_found' } });
    const encodedAPI404 = await app.inject({ url: '/v1%2fdoes-not-exist' });
    assert.equal(encodedAPI404.statusCode, 404);

    const traversal = await app.inject({ url: `/..%2f${outsideName}` });
    assert.equal(traversal.statusCode, 404);
    assert.equal(traversal.body.includes('private'), false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
