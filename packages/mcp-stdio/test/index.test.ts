import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { endpointOf, PACKAGE_NAME, run, sseMessages, StdioProxy } from '../src/index.js';

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records what it was sent and answers from a script. */
function scripted(answer: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const impl = (async (url: URL | string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    return answer(body);
  }) as typeof fetch;
  return { seen, impl };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('@floorspec/mcp-stdio', () => {
  it('names itself', () => {
    expect(PACKAGE_NAME).toBe('@floorspec/mcp-stdio');
  });

  it('finds the /mcp endpoint from an origin or keeps a URL that already names it', () => {
    expect(endpointOf('https://floorspec.d3cloud.io').href).toBe('https://floorspec.d3cloud.io/mcp');
    expect(endpointOf('https://floorspec.d3cloud.io/').href).toBe('https://floorspec.d3cloud.io/mcp');
    expect(endpointOf('http://127.0.0.1:3400/mcp').href).toBe('http://127.0.0.1:3400/mcp');
  });

  it('forwards each line with the bearer token and writes back what the server answers, JSON or SSE', async () => {
    const { seen, impl } = scripted((body) =>
      body['method'] === 'initialize'
        ? new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { protocolVersion: '2025-11-25' } })}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          })
        : body['method'] === 'notifications/initialized'
          ? new Response(null, { status: 202 })
          : json({ jsonrpc: '2.0', id: body['id'], result: { tools: [] } }),
    );
    const out: string[] = [];
    const proxy = new StdioProxy({ url: 'http://floorspec.test', token: 'fls_secret', fetch: impl, write: (l) => out.push(l) });
    proxy.accept(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }));
    await proxy.drain();
    proxy.accept(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    proxy.accept(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    await proxy.drain();

    expect(out.map((l) => JSON.parse(l) as unknown)).toEqual([
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', id: 2, result: { tools: [] } },
    ]);
    expect(seen.every((s) => s.url === 'http://floorspec.test/mcp' && s.headers['authorization'] === 'Bearer fls_secret')).toBe(true);
    // After initialize, the negotiated revision rides along as a header.
    expect(seen[0]?.headers['mcp-protocol-version']).toBeUndefined();
    expect(seen[2]?.headers['mcp-protocol-version']).toBe('2025-11-25');
  });

  it('mirrors a 2026-07-28 request envelope into the protocol headers', async () => {
    const { seen, impl } = scripted((body) => json({ jsonrpc: '2.0', id: body['id'], result: {} }));
    const proxy = new StdioProxy({ url: 'http://floorspec.test', token: 't', fetch: impl, write: () => undefined });
    proxy.accept(JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }));
    await proxy.drain();
    expect(seen[0]?.headers).toMatchObject({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' });
  });

  it('answers a request the server refused, or could not be reached for, with a JSON-RPC error', async () => {
    const refused = scripted(() => json({ error: 'a bearer token is required' }, 401));
    const out: string[] = [];
    const proxy = new StdioProxy({ url: 'http://floorspec.test', token: 'bad', fetch: refused.impl, write: (l) => out.push(l) });
    proxy.accept(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }));
    proxy.accept(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    proxy.accept('not json');
    await proxy.drain();
    const replies = out.map((l) => JSON.parse(l) as { id: unknown; error: { code: number; message: string } });
    const refusal = replies.find((r) => r.id === 7)?.error;
    expect(refusal?.code).toBe(-32001);
    expect(refusal?.message).toContain('FLOORSPEC_TOKEN');
    expect(replies.find((r) => r.id === null)?.error.code).toBe(-32700);
    expect(replies).toHaveLength(2);

    const down = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    const out2: string[] = [];
    const proxy2 = new StdioProxy({ url: 'http://floorspec.test', token: 't', fetch: down, write: (l) => out2.push(l) });
    proxy2.accept(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }));
    await proxy2.drain();
    const unreachable = JSON.parse(out2[0] ?? '{}') as { id: number; error: { code: number; message: string } };
    expect(unreachable).toMatchObject({ id: 8, error: { code: -32000 } });
    expect(unreachable.error.message).toContain('ECONNREFUSED');
  });

  it('refuses to start without a token', async () => {
    const logs: string[] = [];
    expect(await run(new PassThrough(), new PassThrough(), {}, (l) => logs.push(l))).toBe(2);
    expect(logs[0]).toContain('FLOORSPEC_TOKEN');
  });

  it('runs over stdin and stdout until input ends', async () => {
    const { impl } = scripted((body) => json({ jsonrpc: '2.0', id: body['id'], result: { ok: true } }));
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    const done = run(input, output, { FLOORSPEC_TOKEN: 'fls_x', FLOORSPEC_URL: 'http://floorspec.test' }, () => undefined, impl);
    input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    expect(await done).toBe(0);
    expect(written.join('')).toBe(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`);
  });

  it('splits an SSE body into its messages', () => {
    expect([...sseMessages('event: message\ndata: {"a":1}\n\nid: 2\ndata: {"b":\ndata: 2}\n\n')]).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('is the exact file the Claude Code plugin carries (rebuild it with `pnpm --filter @floorspec/mcp-stdio plugin`)', () => {
    const built = readFileSync(join(import.meta.dirname, '../dist/floorspec-mcp.js'), 'utf8');
    const carried = readFileSync(join(import.meta.dirname, '../../../plugin/bin/floorspec-mcp.mjs'), 'utf8');
    expect(carried).toBe(built);
  });
});
