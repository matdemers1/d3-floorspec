import type { ReactNode } from 'react';

/**
 * Markdown-lite (FLR-T-9.6): a comment's `**bold**`, `*italic*`, `` `code` `` and line breaks, and
 * nothing else — no links, no images, no HTML. Every piece becomes a React text node inside a fixed
 * element, so whatever a person types is shown as text: `<img onerror>` is the eleven characters
 * it is, never markup. Unmatched markers are left as they were typed.
 */

type Token = { kind: 'text' | 'strong' | 'em' | 'code'; text: string };

/** Code; bold and italic only when the markers hug their text, so `2 * 3 * 4` stays arithmetic. */
const INLINE = /(`[^`\n]+`)|(\*\*(?=\S)[^*\n]*?[^\s*]\*\*)|(\*(?=[^\s*])[^*\n]*?[^\s*]\*)/g;

export function tokens(line: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    const at = m.index;
    if (at > last) out.push({ kind: 'text', text: line.slice(last, at) });
    const raw = m[0];
    if (m[1] !== undefined) out.push({ kind: 'code', text: raw.slice(1, -1) });
    else if (m[2] !== undefined) out.push({ kind: 'strong', text: raw.slice(2, -2) });
    else out.push({ kind: 'em', text: raw.slice(1, -1) });
    last = at + raw.length;
  }
  if (last < line.length) out.push({ kind: 'text', text: line.slice(last) });
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <div className={className}>
      {paragraphs.map((paragraph, p) => (
        <p key={p}>
          {paragraph.split('\n').flatMap((line, i) => {
            const parts: ReactNode[] = tokens(line).map((t, j) => {
              const key = `${String(i)}-${String(j)}`;
              if (t.kind === 'strong') return <strong key={key}>{t.text}</strong>;
              if (t.kind === 'em') return <em key={key}>{t.text}</em>;
              if (t.kind === 'code') return <code key={key}>{t.text}</code>;
              return <span key={key}>{t.text}</span>;
            });
            return i === 0 ? parts : [<br key={`br${String(i)}`} />, ...parts];
          })}
        </p>
      ))}
    </div>
  );
}
