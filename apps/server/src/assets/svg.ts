/**
 * Plan symbols as SVG (FLR-T-8.3, FS_furniture 3.3, Core 12.6): an SVG is a document that can run
 * script, load other files and expand entities, so one is never stored as it came. It is read with a
 * small strict tokenizer and kept only as an allowlist of drawing — shapes, paths, text, gradients,
 * clip paths and references inside the file — and everything else is removed: scripts, event
 * handlers, `foreignObject`, `<style>` sheets, links and every reference to anything outside the file.
 * A DOCTYPE (and so any entity) is refused outright rather than parsed.
 *
 * When nothing had to be removed the bytes are kept exactly as they came, so a library symbol keeps
 * the digest its catalogue names; otherwise the file is written again from what was kept. Either
 * way the digest is of the stored bytes, the bytes served and the bytes the document's `sha256`
 * names — as with a photo's EXIF (media.ts).
 *
 * This is one of three layers. The asset route serves every file with `Content-Security-Policy:
 * default-src 'none'; sandbox` and `nosniff`, and the editor only ever draws a symbol through an
 * image element (`<image>` in the plan, `<img>` in the library), where a browser runs no script and
 * loads nothing else whatever the file says. The editor never inlines an SVG into its own page.
 */

export class SvgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SvgError';
  }
}

export interface SanitizedSvg {
  readonly bytes: Uint8Array;
  /** What was removed, for the audit trail: element and attribute names, `comment`, `xml-declaration` … */
  readonly removed: readonly string[];
  /** The viewBox's width and height, rounded, or the width and height attributes; 0 when neither says. */
  readonly width: number;
  readonly height: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Elements kept: drawing, and the definitions drawing refers to. Anything else is removed with everything inside it. */
const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'symbol', 'use',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker',
]);

/** Elements whose text is kept. Text anywhere else is whitespace or is dropped. */
const TEXT_ELEMENTS = new Set(['title', 'desc', 'text', 'tspan']);

/** Attributes kept, on any kept element: geometry, presentation and the structure that references stay inside. */
const ATTRIBUTES = new Set([
  'id', 'class', 'transform', 'viewBox', 'preserveAspectRatio', 'version', 'xmlns', 'xmlns:xlink', 'xml:space', 'lang', 'xml:lang',
  'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'fx', 'fy', 'fr', 'd', 'points', 'pathLength',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'vector-effect', 'opacity', 'color', 'display', 'visibility', 'clip-path', 'clip-rule', 'mask',
  'shape-rendering', 'paint-order', 'marker-start', 'marker-mid', 'marker-end',
  'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'stop-color', 'stop-opacity',
  'clipPathUnits', 'maskUnits', 'maskContentUnits', 'patternUnits', 'patternContentUnits', 'patternTransform',
  'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'style', 'href', 'xlink:href',
]);

/** A reference to something inside this file: `#name`. Nothing else may be referred to. */
const LOCAL_REF = /^#[A-Za-z_][\w.:-]*$/;
/** `url(#name)` and nothing else: a paint, clip or mask from this file. */
const URL_ANY = /url\s*\(/i;
const URL_LOCAL = /url\(\s*(['"]?)#[A-Za-z_][\w.:-]*\1\s*\)/gi;

/** An inline style that cannot load or run anything: no url() but local ones, no at-rules, no escapes, no expressions. */
function safeStyle(v: string): boolean {
  if (/[\\<>@]|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(v)) return false;
  return !URL_ANY.test(v.replace(URL_LOCAL, ''));
}

function safeValue(name: string, v: string): boolean {
  if (name === 'href' || name === 'xlink:href') return LOCAL_REF.test(v.trim());
  if (name === 'style') return safeStyle(v);
  if (name === 'xmlns') return v === SVG_NS;
  if (name === 'xmlns:xlink') return v === XLINK_NS;
  // A presentation attribute may name a paint or a clip in this file, and nothing outside it.
  if (URL_ANY.test(v)) return !URL_ANY.test(v.replace(URL_LOCAL, ''));
  return !/javascript:|data:/i.test(v);
}

const MAX_DEPTH = 64;
const MAX_ELEMENTS = 50_000;

interface Attr {
  name: string;
  /** The value with its references (`&amp;` …) resolved. */
  value: string;
}

interface Node {
  name: string;
  attrs: Attr[];
  children: (Node | string)[];
}

const PREDEFINED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Resolve character references; any other entity is refused (they come only from a DOCTYPE, which is refused). */
function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (_m, ref: string) => {
    if (ref.startsWith('#x')) return codePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return codePoint(parseInt(ref.slice(1), 10));
    const v = PREDEFINED[ref];
    if (v === undefined) throw new SvgError(`this SVG uses the entity &${ref};, which only a DOCTYPE could define`);
    return v;
  });
}

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new SvgError('this SVG has a character reference to no character');
  return String.fromCodePoint(n);
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');

const NAME = /^[A-Za-z_][\w.:-]*/;

/**
 * Read an SVG and keep only its drawing. SvgError when it is not an SVG this can read: not UTF-8,
 * not well-formed, a DOCTYPE, a root that is not `<svg>`.
 */
export function sanitizeSvg(input: Uint8Array): SanitizedSvg {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new SvgError('an SVG must be UTF-8 text');
  }
  const removed = new Set<string>();
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const root: Node = { name: '#root', attrs: [], children: [] };
  const stack: Node[] = [root];
  /** Depth inside a removed element: its whole subtree is skipped. */
  let skipping = 0;
  let elements = 0;
  let sawRoot = false;
  let rootClosed = false;

  const top = (): Node => stack[stack.length - 1] as Node;

  while (at < text.length) {
    const lt = text.indexOf('<', at);
    const chunk = lt === -1 ? text.slice(at) : text.slice(at, lt);
    if (chunk.length > 0) {
      if (stack.length === 1) {
        if (/\S/.test(chunk)) throw new SvgError('this SVG has text outside its <svg> element');
      } else if (skipping === 0) {
        const parent = top();
        if (TEXT_ELEMENTS.has(parent.name)) parent.children.push(unescape(chunk));
        else if (/\S/.test(chunk)) removed.add('text');
        else parent.children.push(chunk);
      }
    }
    if (lt === -1) break;
    at = lt;
    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end === -1) throw new SvgError('this SVG has a comment that never ends');
      removed.add('comment');
      at = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', at)) {
      const end = text.indexOf(']]>', at + 9);
      if (end === -1) throw new SvgError('this SVG has a CDATA section that never ends');
      const body = text.slice(at + 9, end);
      if (skipping === 0 && stack.length > 1 && TEXT_ELEMENTS.has(top().name)) top().children.push(body);
      else removed.add('cdata');
      at = end + 3;
      continue;
    }
    if (text.startsWith('<!', at)) throw new SvgError('an SVG with a DOCTYPE or other declaration is refused: entities can expand or fetch other files');
    if (text.startsWith('<?', at)) {
      const end = text.indexOf('?>', at + 2);
      if (end === -1) throw new SvgError('this SVG has a processing instruction that never ends');
      const pi = text.slice(at + 2, end);
      if (!/^xml\s/.test(pi) || sawRoot) removed.add('processing-instruction');
      else removed.add('xml-declaration');
      at = end + 2;
      continue;
    }
    if (text.startsWith('</', at)) {
      const end = text.indexOf('>', at);
      if (end === -1) throw new SvgError('this SVG is cut short');
      const name = text.slice(at + 2, end).trim();
      if (stack.length === 1) throw new SvgError(`this SVG closes </${name}>, which was never opened`);
      if (skipping > 0) {
        skipping -= 1;
        if (skipping === 0) stack.pop();
      } else {
        if (top().name !== name) throw new SvgError(`this SVG closes </${name}> inside <${top().name}>`);
        stack.pop();
      }
      if (stack.length === 1) rootClosed = true;
      at = end + 1;
      continue;
    }
    // A start tag.
    at += 1;
    const nm = NAME.exec(text.slice(at, at + 200));
    if (nm === null) throw new SvgError('this SVG has a tag with no name');
    const name = nm[0];
    at += name.length;
    const attrs: Attr[] = [];
    let selfClosing = false;
    for (;;) {
      while (at < text.length && /\s/.test(text.charAt(at))) at += 1;
      if (at >= text.length) throw new SvgError('this SVG is cut short');
      if (text.startsWith('/>', at)) {
        selfClosing = true;
        at += 2;
        break;
      }
      if (text.charAt(at) === '>') {
        at += 1;
        break;
      }
      const an = NAME.exec(text.slice(at, at + 200));
      if (an === null) throw new SvgError(`this SVG has a malformed attribute on <${name}>`);
      at += an[0].length;
      while (/\s/.test(text.charAt(at))) at += 1;
      if (text.charAt(at) !== '=') throw new SvgError(`the attribute ${an[0]} on <${name}> has no value`);
      at += 1;
      while (/\s/.test(text.charAt(at))) at += 1;
      const quote = text.charAt(at);
      if (quote !== '"' && quote !== "'") throw new SvgError(`the attribute ${an[0]} on <${name}> is not quoted`);
      const close = text.indexOf(quote, at + 1);
      if (close === -1) throw new SvgError('this SVG is cut short');
      const raw = text.slice(at + 1, close);
      if (raw.includes('<')) throw new SvgError(`the attribute ${an[0]} on <${name}> contains "<"`);
      if (attrs.some((a) => a.name === an[0])) throw new SvgError(`<${name}> has ${an[0]} twice`);
      attrs.push({ name: an[0], value: unescape(raw) });
      at = close + 1;
    }
    elements += 1;
    if (elements > MAX_ELEMENTS) throw new SvgError(`an SVG symbol may have at most ${String(MAX_ELEMENTS)} elements`);
    if (stack.length === 1) {
      if (sawRoot || rootClosed) throw new SvgError('this SVG has more than one root element');
      if (name !== 'svg') throw new SvgError(`this is not an SVG: its root element is <${name}>`);
      sawRoot = true;
    }
    if (skipping > 0) {
      if (!selfClosing) skipping += 1;
      continue;
    }
    if (stack.length > MAX_DEPTH) throw new SvgError(`an SVG symbol may nest at most ${String(MAX_DEPTH)} elements deep`);
    const kept = ELEMENTS.has(name) && !(name === 'use' && !attrs.some((a) => (a.name === 'href' || a.name === 'xlink:href') && LOCAL_REF.test(a.value.trim())));
    if (!kept) {
      removed.add(`<${name}>`);
      if (!selfClosing) {
        // Kept on the stack only to match its end tag; nothing inside it is kept.
        stack.push({ name, attrs: [], children: [] });
        skipping = 1;
      }
      continue;
    }
    const node: Node = { name, attrs: [], children: [] };
    for (const a of attrs) {
      if (ATTRIBUTES.has(a.name) && safeValue(a.name, a.value)) node.attrs.push(a);
      else removed.add(`@${a.name}`);
    }
    if (name === 'svg' && stack.length === 1 && !node.attrs.some((a) => a.name === 'xmlns')) {
      node.attrs.unshift({ name: 'xmlns', value: SVG_NS });
      removed.add('@xmlns (added)');
    }
    if (node.attrs.some((a) => a.name === 'xlink:href') && !node.attrs.some((a) => a.name === 'xmlns:xlink') && !inheritsXlink(stack)) {
      // An xlink:href with no xlink namespace in scope is not well-formed XML: use plain href instead.
      const i = node.attrs.findIndex((a) => a.name === 'xlink:href');
      const a = node.attrs[i] as Attr;
      node.attrs.splice(i, 1, { name: 'href', value: a.value });
      removed.add('@xlink:href (renamed)');
    }
    top().children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (!sawRoot) throw new SvgError('this is not an SVG: it has no <svg> element');
  if (stack.length !== 1) throw new SvgError('this SVG is cut short: an element is never closed');

  const svg = root.children.find((c): c is Node => typeof c !== 'string') as Node;
  const size = sizeOf(svg);
  // Only a removal or a rewrite changes the bytes: a clean file is kept exactly as it came.
  const changed = [...removed].filter((r) => r !== 'xml-declaration');
  if (changed.length === 0) return { bytes: input, removed: [], ...size };
  const out = `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(svg)}\n`;
  return { bytes: new TextEncoder().encode(out), removed: changed.sort(), ...size };
}

function inheritsXlink(stack: readonly Node[]): boolean {
  return stack.some((n) => n.attrs.some((a) => a.name === 'xmlns:xlink'));
}

function serialize(n: Node): string {
  const attrs = n.attrs.map((a) => ` ${a.name}="${escAttr(a.value)}"`).join('');
  if (n.children.length === 0) return `<${n.name}${attrs}/>`;
  return `<${n.name}${attrs}>${n.children.map((c) => (typeof c === 'string' ? escText(c) : serialize(c))).join('')}</${n.name}>`;
}

/** The symbol's drawing size: its viewBox, else its width and height in whatever units they give. */
function sizeOf(svg: Node): { width: number; height: number } {
  const get = (k: string) => svg.attrs.find((a) => a.name === k)?.value;
  const vb = get('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (vb !== undefined && vb.length === 4 && vb.every(Number.isFinite)) return { width: clampInt(vb[2] ?? 0), height: clampInt(vb[3] ?? 0) };
  return { width: clampInt(parseFloat(get('width') ?? '')), height: clampInt(parseFloat(get('height') ?? '')) };
}

const clampInt = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.min(2_000_000_000, Math.round(n)) : 0);

/** Whether bytes look like an SVG: text whose first element is `<svg`, after any declaration, comments and whitespace. */
export function looksLikeSvg(b: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 4096)).replace(/^\uFEFF/, '');
  const stripped = head.replace(/^\s*(<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*/i, '');
  return /^<svg[\s>/]/.test(stripped);
}
