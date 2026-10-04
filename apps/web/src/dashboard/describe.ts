/** What a log entry did, in words: "Created the project", or its op names and count. */
export function describeOps(ops: readonly { op: string }[]): string {
  if (ops.length === 1 && ops[0]?.op === 'createProject') return 'Created the project';
  const names = [...new Set(ops.map((o) => o.op))];
  const head = names.slice(0, 2).join(', ');
  return `${head}${names.length > 2 ? ` and ${String(names.length - 2)} more` : ''} · ${String(ops.length)} op${ops.length === 1 ? '' : 's'}`;
}
