// The forge's HTTP server: health, REST v3, git smart HTTP, GraphQL
// and MCP, routed by path. main.ts owns the lifecycle (bind, register,
// poll for done); this file owns the surface the suite scores.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { Rest, sendJson } from './rest.ts';
import { handleGit } from './gitproto.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const forge = new Forge(process.env.MAKEFUN_TRIAL_NOW);
  const rest = new Rest(forge, token);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    void (async () => {
      try {
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const handled = await rest.handle(req, res, urlOf(req));
          if (!handled) sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': forge.requestId() });
          return;
        }
        if (path === '/api/graphql') {
          await handleGraphql(forge, token, req, res);
          return;
        }
        if (path === '/mcp') {
          await handleMcp(forge, token, req, res);
          return;
        }
        if (await handleGit(forge, token, req, res, urlOf(req))) return;
        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
