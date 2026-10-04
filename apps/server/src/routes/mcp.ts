import { Readable } from 'node:stream';
import type { Express, Request, Response } from 'express';
import { createFloorspecMcpHandler, HttpFloorspecClient } from '@floorspec/mcp';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { wwwAuthenticate } from '../auth/resource-server.js';

/**
 * The remote MCP endpoint (FLR-T-2.6): MCP 2026-07-28 over Streamable HTTP at `/mcp`.
 *
 * **Bearer only.** A per-project API token, or a D3 Auth access token minted for this resource —
 * never a session cookie: an MCP client is a program, and a cookie on its request would be a
 * browser being used against itself. A request with no usable credential gets the RFC 9728
 * challenge, which is how Claude's connector discovers where to sign in.
 *
 * **Stateless, and the same guards.** A fresh MCP server per request, handed a client that loops
 * back to this API with the caller's own `Authorization` header. Every tool call is an ordinary API
 * request: the same scope checks, project isolation and audit rows, with no second authorisation
 * surface for a check to be missing from.
 */
export function mountMcp(app: Express, config: Config): void {
  const handler = createFloorspecMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as { baseUrl?: string; authorization?: string } | undefined;
      return new HttpFloorspecClient({ baseUrl: extra?.baseUrl ?? `http://127.0.0.1:${String(config.PORT)}`, authorization: extra?.authorization ?? '' });
    },
    (error) => {
      logger.warn({ err: error.message }, 'MCP request refused');
    },
  );

  app.post('/mcp', (req, res, next) => {
    const principal = req.token;
    if (principal === undefined) {
      res.setHeader('WWW-Authenticate', wwwAuthenticate(config, req.get('authorization') === undefined ? undefined : 'invalid_token'));
      res.status(401).json({ error: 'a bearer token is required: a D3 Floorspec API token, or sign in with D3 Auth' });
      return;
    }
    // The port this request arrived on, not the configured one: they differ wherever the server was
    // started on port 0, and a loopback to the wrong port looks like a broken MCP server.
    const port = req.socket.localPort ?? config.PORT;
    const authorization = req.get('authorization') ?? '';
    handler
      .fetch(toWebRequest(req), {
        parsedBody: req.body as unknown,
        authInfo: {
          token: authorization.replace(/^bearer\s+/i, ''),
          clientId: principal.name,
          scopes: [...principal.scopes],
          extra: { baseUrl: `http://127.0.0.1:${String(port)}`, authorization },
        },
      })
      .then((response) => sendWebResponse(response, res))
      .catch(next);
  });

  // GET opens a server-to-client stream and DELETE ends a session: a stateless endpoint has
  // neither, and says so rather than falling through to the editor.
  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', (_req, res) => {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ error: 'this MCP endpoint is stateless; use POST' });
    });
  }
}

function toWebRequest(req: Request): globalThis.Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  const url = new URL(req.originalUrl, `${req.protocol}://${req.get('host') ?? 'localhost'}`);
  return new Request(url, {
    method: req.method,
    headers,
    // The body was already parsed by express.json(); the handler takes it as `parsedBody`.
    ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: JSON.stringify(req.body ?? null) }),
  });
}

async function sendWebResponse(response: globalThis.Response, res: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  if (response.body === null) {
    res.end();
    return;
  }
  // A stream, for an SSE response; a buffer would hold a long tool call's progress until the end.
  const stream = Readable.fromWeb(response.body);
  res.on('close', () => {
    stream.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
}
