# The Floorspec plugin for Claude Code

Design a house as code with Claude (FLR-T-2.10). The plugin carries:

- **`floorspec` MCP server** — `bin/floorspec-mcp.mjs`, the stdio shim from `packages/mcp-stdio`,
  which forwards Claude Code's MCP messages to a D3 Floorspec server's `/mcp` with your token. One
  file, no dependencies, Node 22.
- **`floorspec-design-partner` skill** — the system prompt: read the summary first, propose typed
  Floorspec Ops with references, render and look, validate and check findings, and never claim a
  change without a committed result and a render. The MCP server offers the same text as the
  prompt `design-partner`; a test in `packages/mcp` keeps them identical.

## Use it

1. In D3 Floorspec, open **Account › API tokens** and create a token for the project. An **agent**
   token is the right one for Claude: its edits land in a named changeset you accept or reject on
   the project page, never straight on the plan. A **write** token commits to the plan as you.
2. Export the token and start Claude Code with the plugin:

   ```bash
   export FLOORSPEC_TOKEN=fls_…                       # shown once, when you create it
   export FLOORSPEC_URL=https://floorspec.d3cloud.io  # the default; or http://localhost:3400
   claude --plugin-dir ./plugin
   ```

Without the shim, Claude Code can reach the server directly:

```bash
claude mcp add --transport http floorspec https://floorspec.d3cloud.io/mcp \
  --header "Authorization: Bearer $FLOORSPEC_TOKEN"
```

claude.ai's connector uses the same `/mcp` URL and signs in through D3 Auth instead of a token.

## Keeping the shim in step

`bin/floorspec-mcp.mjs` is the built `packages/mcp-stdio/dist/floorspec-mcp.js`, byte for byte, and
that package's tests fail when the two differ. After changing the shim:

```bash
pnpm --filter @floorspec/mcp-stdio plugin
```

## The agent eval

The 30-task agent eval (FLR-REQ-055, `evals/agent`) runs Claude with this plugin — this skill as
the system prompt and these tools — so the tools and the prompt are judged together.
