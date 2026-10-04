#!/usr/bin/env node
/**
 * floorspec-mcp — the stdio shim for Claude Code (FLR-T-2.10).
 *
 * Claude Code starts this as a local stdio MCP server; it forwards every JSON-RPC message, as it
 * is, to a D3 Floorspec server's `/mcp` over Streamable HTTP with the token from the environment,
 * and writes every message the server answers with back to stdout. It understands no MCP method:
 * the server is the MCP server, and both protocol eras (2025-11-25 and 2026-07-28) pass through.
 *
 *   FLOORSPEC_URL    the server — `https://floorspec.d3cloud.io`, or its `/mcp` URL
 *   FLOORSPEC_TOKEN  a project API token (`fls_…`) from Account › API tokens
 *
 * One file and no dependencies, so the Claude Code plugin can carry it as it is. Nothing is
 * logged anywhere but stderr, and nothing leaves the machine except to FLOORSPEC_URL.
 */
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
export const DEFAULT_URL = 'https://floorspec.d3cloud.io';
export const USER_AGENT = 'floorspec-mcp/0.1.0';
/** The `/mcp` endpoint for a configured URL: an origin gets `/mcp`, a URL ending in it is kept. */
export function endpointOf(url) {
    const parsed = new URL(url);
    if (!parsed.pathname.replace(/\/+$/, '').endsWith('/mcp'))
        parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/mcp`;
    return parsed;
}
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
/** The JSON-RPC error a request gets when the server could not be reached or refused it. */
function errorFor(message, code, text, data) {
    if (!('id' in message) || message['id'] === null || typeof message['method'] !== 'string')
        return null;
    return { jsonrpc: '2.0', id: message['id'], error: { code, message: text, ...(data === undefined ? {} : { data }) } };
}
/** Parse a `text/event-stream` body into the JSON-RPC messages its `data:` lines carry. */
export function* sseMessages(body) {
    for (const event of body.split(/\r?\n\r?\n/)) {
        const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (data.trim().length > 0)
            yield JSON.parse(data);
    }
}
export class StdioProxy {
    options;
    endpoint;
    fetchImpl;
    /** The revision negotiated by a 2025-era `initialize`, sent as a header from then on. */
    protocolVersion = null;
    sessionId = null;
    pending = new Set();
    constructor(options) {
        this.options = options;
        this.endpoint = endpointOf(options.url);
        this.fetchImpl = options.fetch ?? fetch;
    }
    /** Forward one line from stdin. Returns at once; the answer is written when it arrives. */
    accept(line) {
        if (line.trim().length === 0)
            return;
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            this.options.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
            return;
        }
        const task = this.forward(message).finally(() => this.pending.delete(task));
        this.pending.add(task);
    }
    /** Wait for every forwarded message to be answered. */
    async drain() {
        while (this.pending.size > 0)
            await Promise.allSettled([...this.pending]);
    }
    headers(message) {
        const headers = {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${this.options.token}`,
            'user-agent': USER_AGENT,
        };
        // 2026-07-28 messages carry their revision in a per-request envelope, mirrored into headers;
        // 2025-era ones send the revision `initialize` negotiated.
        const meta = message['params']?._meta;
        const version = typeof meta?.[META_VERSION] === 'string' ? meta[META_VERSION] : this.protocolVersion;
        if (version !== null)
            headers['mcp-protocol-version'] = version;
        if (typeof meta?.[META_VERSION] === 'string' && typeof message['method'] === 'string')
            headers['mcp-method'] = message['method'];
        if (this.sessionId !== null)
            headers['mcp-session-id'] = this.sessionId;
        return headers;
    }
    emit(value) {
        if (Array.isArray(value))
            for (const item of value)
                this.emit(item);
        else {
            const result = value?.result;
            if (typeof result?.protocolVersion === 'string')
                this.protocolVersion = result.protocolVersion;
            this.options.write(JSON.stringify(value));
        }
    }
    async forward(message) {
        let res;
        try {
            res = await this.fetchImpl(this.endpoint, { method: 'POST', headers: this.headers(message), body: JSON.stringify(message) });
        }
        catch (error) {
            const text = `could not reach ${this.endpoint.origin}: ${error instanceof Error ? error.message : String(error)}`;
            this.options.log?.(text);
            const reply = errorFor(message, -32000, text);
            if (reply !== null)
                this.options.write(JSON.stringify(reply));
            return;
        }
        const session = res.headers.get('mcp-session-id');
        if (session !== null)
            this.sessionId = session;
        const body = await res.text();
        if (res.status === 202 || (res.ok && body.trim().length === 0))
            return;
        if (!res.ok) {
            let parsed = body;
            try {
                parsed = JSON.parse(body);
            }
            catch {
                /* not JSON: pass the text */
            }
            // A JSON-RPC error body (the SDK answers some refusals that way) is relayed as it is.
            if (typeof parsed === 'object' && parsed !== null && 'jsonrpc' in parsed) {
                this.emit(parsed);
                return;
            }
            const hint = res.status === 401 ? ' — check FLOORSPEC_TOKEN: a project API token from Account › API tokens' : '';
            const text = `D3 Floorspec answered ${String(res.status)}${hint}`;
            this.options.log?.(text);
            const reply = errorFor(message, res.status === 401 || res.status === 403 ? -32001 : -32000, text, parsed);
            if (reply !== null)
                this.options.write(JSON.stringify(reply));
            return;
        }
        if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
            for (const item of sseMessages(body))
                this.emit(item);
        }
        else {
            this.emit(JSON.parse(body));
        }
    }
}
/** Run the shim on a pair of streams. Resolves when input ends and every answer is written. */
export async function run(input, output, env, log, fetchImpl) {
    const token = env['FLOORSPEC_TOKEN'];
    if (token === undefined || token.trim().length === 0) {
        log('floorspec-mcp: FLOORSPEC_TOKEN is not set. Create a project API token in D3 Floorspec (Account › API tokens).');
        return 2;
    }
    const proxy = new StdioProxy({
        url: env['FLOORSPEC_URL'] ?? DEFAULT_URL,
        token: token.trim(),
        write: (line) => output.write(`${line}\n`),
        log,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines)
        proxy.accept(line);
    await proxy.drain();
    return 0;
}
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
    run(process.stdin, process.stdout, process.env, (line) => process.stderr.write(`${line}\n`)).then((code) => process.exit(code), (error) => {
        process.stderr.write(`floorspec-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=floorspec-mcp.js.map