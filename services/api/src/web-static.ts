import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ServiceError } from './errors.js';

const contentTypes: Record<string, string> = {
  '.avif': 'image/avif', '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg', '.otf': 'font/otf', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function fileAt(root: string, pathname: string): Promise<{ path: string; size: number; modified: Date } | undefined> {
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, `.${pathname}`);
  if (!isInside(canonicalRoot, candidate)) return undefined;
  try {
    const canonicalFile = await realpath(candidate);
    if (!isInside(canonicalRoot, canonicalFile)) return undefined;
    const details = await stat(canonicalFile);
    return details.isFile() ? { path: canonicalFile, size: details.size, modified: details.mtime } : undefined;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined;
    throw error;
  }
}

async function sendFile(request: FastifyRequest, reply: FastifyReply, root: string, pathname: string) {
  if (!isInside(root, resolve(root, `.${pathname}`))) throw new ServiceError('not_found', 404);
  let file = await fileAt(root, pathname);
  if (!file && pathname !== '/index.html') file = await fileAt(root, '/index.html');
  if (!file) throw new ServiceError('not_found', 404);

  const assetPath = pathname.startsWith('/assets/') && /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(pathname);
  reply.type(contentTypes[extname(file.path).toLowerCase()] ?? 'application/octet-stream')
    .header('Cache-Control', assetPath ? 'public, max-age=31536000, immutable' : 'no-cache')
    .header('Last-Modified', file.modified.toUTCString())
    .header('Content-Length', String(file.size));
  if (request.method === 'HEAD') return reply.send();
  return reply.send(createReadStream(file.path));
}

export function webNotFoundHandler(root: string | undefined) {
  const webRoot = root ? resolve(root) : undefined;
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const rawPath = (request.raw.url ?? request.url).split('?', 1)[0] ?? '/';
    if (webRoot && ['GET', 'HEAD'].includes(request.method)) {
      let pathname: string;
      try { pathname = decodeURIComponent(rawPath); }
      catch { throw new ServiceError('not_found', 404); }
      if (pathname === '/v1' || pathname.startsWith('/v1/')) throw new ServiceError('not_found', 404);
      if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) throw new ServiceError('not_found', 404);
      return sendFile(request, reply, webRoot, pathname);
    }
    throw new ServiceError('not_found', 404);
  };
}
