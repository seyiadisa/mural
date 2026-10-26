import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const children = new Set();
let stopping = false;
let exitCode = 0;
let startupStage = 'database_migrations';

const knownFailureCodes = new Set([
  'migration_database_url_missing',
  'migration_process_failed',
  'api_exited_before_ready',
  'api_not_ready',
  'ENOENT',
  'EACCES',
  'EPERM',
  'EPIPE',
  'ECONNREFUSED',
  'EADDRINUSE',
  'ETIMEDOUT',
  'ECONNRESET',
]);

function safeFailureCode(error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && knownFailureCodes.has(code) ? code : 'unexpected_error';
}

function startupFailure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stop(code = 0) {
  if (!stopping) {
    stopping = true;
    exitCode = code;
    for (const child of children) child.kill('SIGTERM');
  }
  if (children.size === 0) process.exitCode = exitCode;
}

function startChild(command, args, options = {}, supervise = false, processName = 'child') {
  const child = spawn(command, args, { ...options, stdio: 'inherit' });
  children.add(child);
  child.once('error', error => {
    console.error(JSON.stringify({ event: 'container_process_start_failed', process: processName,
      code: safeFailureCode(error) }));
    children.delete(child);
    stop(1);
  });
  child.once('exit', code => {
    children.delete(child);
    if (supervise && !stopping) {
      console.error(JSON.stringify({ event: 'container_process_exited', process: processName,
        exitCode: code ?? null }));
      stop(code === 0 ? 1 : code ?? 1);
    }
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
  if (!migrationURL) throw startupFailure('migration_database_url_missing');
  const child = startChild(process.execPath, ['/app/services/api/dist/src/migrate.js'], {
    env: { ...process.env, DATABASE_URL: migrationURL },
  }, false, 'migrations');
  const result = await waitForExit(child);
  if (result.code !== 0) throw startupFailure('migration_process_failed');
}

async function waitForAPI(child) {
  const headers = {
    'x-mural-proxy-token': process.env.ACCOUNTS_PROXY_TOKEN ?? '',
    'x-mural-client-ip': '127.0.0.1',
  };
  for (let attempt = 0; attempt < 90 && !stopping; attempt += 1) {
    if (child.exitCode !== null) throw startupFailure('api_exited_before_ready');
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
  if (!stopping) throw startupFailure('api_not_ready');
}

process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

try {
  startupStage = 'database_migrations';
  await applyMigrations();
  if (stopping) process.exitCode = exitCode;
  else {
    startupStage = 'api_start';
    const api = startChild(process.execPath, ['/app/services/api/dist/src/main.js'], {
      env: { ...process.env, PORT: '8081', MURAL_API_HOST: '127.0.0.1' },
    }, true, 'api');
    startupStage = 'api_readiness';
    await waitForAPI(api);
    if (!stopping) {
      startupStage = 'reverse_proxy_start';
      startChild('/bin/sh', ['-c', 'exec "$@"', 'sh', '/usr/local/bin/caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
        {}, true, 'caddy');
    }
  }
} catch (error) {
  if (!stopping) {
    console.error(JSON.stringify({ event: 'container_startup_failed', stage: startupStage,
      code: safeFailureCode(error) }));
    stop(1);
  }
}
