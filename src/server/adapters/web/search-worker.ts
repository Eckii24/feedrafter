import { parentPort, workerData } from 'node:worker_threads';
import { DOMParser, parseHTML } from 'linkedom';

type Row = { title: string; url: string; snippet: string };
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const MAX_NODES = 50_000;
const MAX_DEPTH = 128;
const MAX_TEXT = 16_384;

// Conservative raw complexity budget before any DOM allocation. Counting delimiters
// everywhere avoids relying on the HTML parser's error recovery or quote state.
// This is not a process-memory or RSS ceiling.
function preflight(input: string): void {
  let units = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 32 || c >= 9 && c <= 13 || c === 60 || c === 62 || c === 38 || c === 61 || c === 34 || c === 39 || c === 47) {
      if (++units > MAX_NODES) throw new Error('Markup too complex');
    }
  }
}

// This deliberately accepts only a conservative XML 1.0 subset, not all XML.
function validateXml(xml: string): void {
  const validChar = (cp: number) => cp === 9 || cp === 10 || cp === 13 || cp >= 0x20 && cp <= 0xd7ff || cp >= 0xe000 && cp <= 0xfffd || cp >= 0x10000 && cp <= 0x10ffff;
  for (const c of xml) if (!validChar(c.codePointAt(0)!)) throw new Error('Invalid XML character');
  const entities = (s: string) => {
    for (let i = 0; i < s.length; i++) if (s[i] === '&') {
      const end = s.indexOf(';', i + 1);
      if (end < 0 || end - i > 16) throw new Error('Invalid entity');
      const value = s.slice(i + 1, end);
      if (!/^(?:amp|lt|gt|quot|apos)$/.test(value)) {
        if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(value)) throw new Error('Invalid entity');
        const cp = value[1] === 'x' ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
        if (!validChar(cp)) throw new Error('Invalid entity character');
      }
      i = end;
    }
  };
  const stack: string[] = []; let i = 0; let roots = 0; let tokens = 0;
  if (xml.startsWith('\uFEFF')) i++;
  if (xml.startsWith('<?xml', i)) {
    const declaration = /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(['"])1\.0\1(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(['"])[Uu][Tt][Ff]-8\2)?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(['"])(?:yes|no)\3)?[ \t\r\n]*\?>/.exec(xml.slice(i));
    if (!declaration || !declaration[0].startsWith('<?xml')) throw new Error('Invalid declaration');
    i += declaration[0].length;
  }
  while (i < xml.length) {
    if (++tokens > MAX_NODES) throw new Error('XML too complex');
    if (xml[i] !== '<') {
      const end = xml.indexOf('<', i); const text = xml.slice(i, end < 0 ? xml.length : end);
      if (text.includes(']]>') || !stack.length && /[^ \t\r\n]/.test(text)) throw new Error('Invalid text');
      entities(text); i += text.length; continue;
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4); const content = xml.slice(i + 4, end);
      if (end < 0 || content.includes('--') || content.endsWith('-')) throw new Error('Invalid comment');
      i = end + 3; continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      if (end < 0 || !stack.length) throw new Error('Invalid CDATA');
      i = end + 3; continue;
    }
    const close = /^<\/([A-Za-z_][\w.:-]*)[ \t\r\n]*>/.exec(xml.slice(i));
    if (close) { if (stack.pop() !== close[1]) throw new Error('Invalid nesting'); i += close[0].length; continue; }
    const open = /^<([A-Za-z_][\w.:-]*)/.exec(xml.slice(i));
    if (!open || open[1]!.includes(':')) throw new Error('Invalid or namespaced tag');
    i += open[0].length; const attrs = new Set<string>(); let selfClosing: boolean;
    while (true) {
      const tail = /^([ \t\r\n]*)(\/?>)/.exec(xml.slice(i));
      if (tail) { selfClosing = tail[2] === '/>'; i += tail[0].length; break; }
      const attr = /^[ \t\r\n]+([A-Za-z_][\w.:-]*)[ \t\r\n]*=[ \t\r\n]*(?:"([^"<]*)"|'([^'<]*)')/.exec(xml.slice(i));
      if (!attr || attrs.has(attr[1]!)) throw new Error('Invalid attribute');
      // LinkeDOM does not reliably expose XML default namespaces. Reject nonempty
      // declarations lexically, including entity-encoded values, at every depth.
      if (attr[1] === 'xmlns' && (attr[2] ?? attr[3] ?? '') !== '') throw new Error('Unsupported default namespace');
      attrs.add(attr[1]!); entities(attr[2] ?? attr[3] ?? ''); i += attr[0].length;
    }
    if (!stack.length && ++roots !== 1) throw new Error('Multiple roots');
    if (!selfClosing) stack.push(open[1]!);
    if (stack.length > MAX_DEPTH) throw new Error('XML too deep');
  }
  if (stack.length || roots !== 1) throw new Error('Incomplete XML');
}

function parseDuck(body: string): Row[] {
  const { document } = parseHTML(body);
  type Context = { row: Row; anchor: boolean; snippet: boolean; hasAnchor: boolean };
  const rows: Row[] = []; let empty = false; let nodes = 0; let candidates = 0;
  const stack: Array<{ node: Node; depth: number; context: Context | undefined; inContainer: boolean }> = [{ node: document as unknown as Node, depth: 0, context: undefined, inContainer: false }];
  while (stack.length) {
    const { node, depth, context: inherited, inContainer: parentContainer } = stack.pop()!;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('HTML too complex');
    let context = inherited; let inContainer = parentContainer;
    if (node.nodeType === 1) {
      const el = node as Element; const classes = el.classList;
      if (classes.contains('anomaly-modal') || el.tagName.toLowerCase() === 'form' && /(?:challenge|anomaly)/i.test(el.getAttribute('action') ?? '')) throw new Error('Challenge');
      inContainer ||= el.id === 'links' || classes.contains('results');
      if (inContainer && (classes.contains('no-results') || classes.contains('result--no-result'))) empty = true;
      if (inContainer && classes.contains('result') && !classes.contains('result--no-result')) {
        if (++candidates > 1000) throw new Error('Too many results');
        context = { row: { title: '', url: '', snippet: '' }, anchor: false, snippet: false, hasAnchor: false };
        rows.push(context.row);
      }
      if (context) {
        if (el.tagName.toLowerCase() === 'a' && classes.contains('result__a')) {
          if (context.hasAnchor) throw new Error('Multiple anchors');
          context.hasAnchor = true; context.row.url = el.getAttribute('href') ?? '';
          context = { ...context, anchor: true };
        }
        if (classes.contains('result__snippet')) context = { ...context, snippet: true };
      }
    } else if (node.nodeType === 3 && context) {
      const value = node.nodeValue ?? '';
      if (context.anchor) context.row.title += value;
      if (context.snippet) context.row.snippet += value;
      if (context.row.title.length > MAX_TEXT || context.row.snippet.length > MAX_TEXT) throw new Error('Text too long');
    }
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push({ node: child, depth: depth + 1, context, inContainer });
  }
  if (!rows.length && !empty) throw new Error('Missing results');
  for (const row of rows) {
    row.title = normalize(row.title); row.snippet = normalize(row.snippet);
    if (!row.title || !row.url) throw new Error('Invalid result');
  }
  return rows;
}
function parseBing(body: string): Row[] {
  validateXml(body);
  const document = new DOMParser().parseFromString(body, 'text/xml');
  const root = document.documentElement as unknown as Element;
  if (root?.localName !== 'rss') throw new Error('Invalid RSS');
  const rootChildren = Array.from(root.children);
  const channels = rootChildren.filter(child => child.localName === 'channel');
  if (channels.length !== 1 || rootChildren.length !== 1) throw new Error('Invalid channel');
  const channel = channels[0]!;
  const metadata = new Set(['title', 'link', 'description', 'language', 'copyright', 'managingEditor', 'webMaster', 'pubDate', 'lastBuildDate', 'category', 'generator', 'docs', 'cloud', 'ttl', 'image', 'rating', 'textInput', 'skipHours', 'skipDays']);
  const itemFields = new Set(['title', 'link', 'description', 'author', 'category', 'comments', 'enclosure', 'guid', 'pubDate', 'source']);
  const compounds: Record<string, Set<string>> = {
    image: new Set(['url', 'title', 'link', 'width', 'height', 'description']),
    textInput: new Set(['title', 'description', 'name', 'link']),
    skipHours: new Set(['hour']),
    skipDays: new Set(['day']),
  };
  const noText = (parent: Element) => {
    for (const node of Array.from(parent.childNodes)) {
      if ((node.nodeType === 3 || node.nodeType === 4) && (node.nodeValue ?? '').trim()) throw new Error('Unexpected RSS text');
    }
  };
  const leaves = (parent: Element, allowed: Set<string>) => {
    noText(parent);
    for (const child of Array.from(parent.children)) {
      if (!allowed.has(child.localName) || child.children.length) throw new Error('Unknown RSS element');
    }
  };
  noText(root); noText(channel);
  const children = Array.from(channel.children);
  for (const child of children) {
    if (child.localName === 'item') leaves(child, itemFields);
    else if (!metadata.has(child.localName)) throw new Error('Unknown channel element');
    else if (Object.hasOwn(compounds, child.localName)) leaves(child, compounds[child.localName]!);
    else if (child.children.length) throw new Error('Unknown metadata element');
  }
  const items = children.filter(child => child.localName === 'item');
  if (items.length > 1000) throw new Error('Too many items');
  return items.map(item => {
    const field = (name: string) => Array.from(item.children).filter(child => child.localName === name);
    const title = field('title'); const link = field('link'); const description = field('description');
    if (title.length !== 1 || link.length !== 1 || description.length > 1) throw new Error('Invalid item');
    const titleText = title[0]!.textContent ?? ''; const url = link[0]!.textContent ?? ''; const snippet = description[0]?.textContent ?? '';
    if (titleText.length > MAX_TEXT || url.length > MAX_TEXT || snippet.length > MAX_TEXT || !normalize(titleText) || !normalize(url)) throw new Error('Invalid item');
    preflight(snippet);
    return { title: normalize(titleText), url: normalize(url), snippet: normalize(parseHTML(`<html><body>${snippet}</body></html>`).document.body.textContent ?? '') };
  });
}
try {
  const { body, provider } = workerData as { body: Uint8Array; provider: string };
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
  preflight(decoded);
  parentPort!.postMessage({ rows: provider === 'DuckDuckGo' ? parseDuck(decoded) : parseBing(decoded) });
} catch { parentPort!.postMessage({ error: true }); }
