import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const children = new Set();
let stopping = false;
let exitCode = 0;

function stop(code = 0) {
  if (!stopping) {
    stopping = true;
    exitCode = code;
    for (const child of children) child.kill('SIGTERM');
  }
  if (children.size === 0) process.exitCode = exitCode;
}

function startChild(command, args, options = {}, supervise = false) {
  const child = spawn(command, args, { ...options, stdio: 'inherit' });
  children.add(child);
  child.once('error', () => {
    console.error('A Mural container process could not start.');
    children.delete(child);
    stop(1);
  });
  child.once('exit', code => {
    children.delete(child);
    if (supervise && !stopping) stop(code === 0 ? 1 : code ?? 1);
    if (stopping && children.size === 0) process.exitCode = exitCode;
  });
  return child;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function applyMigrations() {
  const migrationURL = process.env.MURAL_MIGRATION_DATABASE_URL;
  if (!migrationURL) throw new Error('MURAL_MIGRATION_DATABASE_URL is required.');
  const child = startChild(process.execPath, ['/app/services/api/dist/src/migrate.js'], {
    env: { ...process.env, DATABASE_URL: migrationURL },
  });
  const result = await waitForExit(child);
  if (result.code !== 0) throw new Error('Database migrations did not complete successfully.');
}

async function waitForAPI(child) {
  const headers = {
    'x-mural-proxy-token': process.env.ACCOUNTS_PROXY_TOKEN ?? '',
    'x-mural-client-ip': '127.0.0.1',
  };
  for (let attempt = 0; attempt < 90 && !stopping; attempt += 1) {
    if (child.exitCode !== null) throw new Error('The Mural API exited during startup.');
    try {
      const response = await fetch('http://127.0.0.1:8081/readyz', {
        headers,
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The API can need a short time to finish its startup checks.
    }
    await delay(1_000);
  }
  if (!stopping) throw new Error('The Mural API did not become ready in time.');
}

process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

try {
  await applyMigrations();
  if (stopping) process.exitCode = exitCode;
  else {
    const api = startChild(process.execPath, ['/app/services/api/dist/src/main.js'], {
      env: { ...process.env, PORT: '8081', MURAL_API_HOST: '127.0.0.1' },
    }, true);
    await waitForAPI(api);
    if (!stopping) startChild('/usr/bin/caddy', ['run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], {}, true);
  }
} catch {
  if (!stopping) {
    console.error('Mural container startup failed. Check the database and service configuration.');
    stop(1);
  }
}
