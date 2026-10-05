/**
 * `pnpm --filter @d3-floorspec/agent-eval prepare <taskId>` — the proxy eval's prepare step.
 *
 * pnpm also runs a script named `prepare` on every `pnpm install`, before anything is built, so this
 * entry imports nothing until it is given a task: with no arguments it prints its usage and exits 0.
 */
const args = process.argv.slice(2);
if (args.length === 0) {
  process.stdout.write('usage: pnpm --filter @d3-floorspec/agent-eval prepare <taskId> [--run N] [--force]\n');
} else {
  process.argv.splice(2, 0, 'prepare');
  await import('./proxy.js');
}
