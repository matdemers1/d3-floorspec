# packages/mcp-stdio

`floorspec-mcp`: a stdio shim for Claude Code that forwards MCP JSON-RPC to a D3 Floorspec server's
`/mcp` over Streamable HTTP (FLR-T-2.10). Both protocol eras pass through; it understands no MCP
method itself.

```bash
FLOORSPEC_URL=https://floorspec.d3cloud.io FLOORSPEC_TOKEN=fls_… floorspec-mcp
```

One dependency-free file. The Claude Code plugin carries a copy at `plugin/bin/floorspec-mcp.mjs`;
after changing the shim run `pnpm --filter @floorspec/mcp-stdio plugin`, or the tests fail.
