import { spawn } from 'node:child_process';

const children = new Set();
let stopping = false;
let exitCode = 0;
let startupStage = 'database_migrations';

const knownFailureCodes = new Set([
  'migration_database_url_missing',
  'migration_process_failed',
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

process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

try {
  startupStage = 'database_migrations';
  await applyMigrations();
  if (stopping) process.exitCode = exitCode;
  else {
    startupStage = 'api_start';
    startChild(process.execPath, ['/app/services/api/dist/src/main.js'], {}, true, 'api');
  }
} catch (error) {
  if (!stopping) {
    console.error(JSON.stringify({ event: 'container_startup_failed', stage: startupStage,
      code: safeFailureCode(error) }));
    stop(1);
  }
}
