import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'web/src';

function openTagEnd(src, from) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return src.length;
}

function visibleText(inner) {
  const rest = inner
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[A-Za-z][^>]*\/>/g, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '');
  return /[\p{L}\p{N}]|\{/u.test(rest);
}

export function findUnlabelled(src) {
  const misses = [];
  const re = /<(button|select)(?=[\s>])/g;
  let m;
  while ((m = re.exec(src))) {
    const end = openTagEnd(src, m.index + m[0].length);
    const open = src.slice(m.index, end + 1);
    if (/\btitle=/.test(open)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    if (m[1] === 'select') {
      if (/aria-label=/.test(open)) misses.push({ line, tag: 'select' });
      continue;
    }
    const close = open.endsWith('/>') ? end : src.indexOf('</button>', end);
    if (!visibleText(src.slice(end + 1, close))) misses.push({ line, tag: 'button' });
  }
  return misses;
}

const files = readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.tsx'));
const misses = files.flatMap((f) => findUnlabelled(readFileSync(join(root, f), 'utf8')).map((x) => `${join(root, f)}:${x.line} ${x.tag} has no visible text and no title; use IconButton or add title=`));
if (misses.length) {
  console.error(`${misses.join('\n')}\n${misses.length} control(s) without hover text`);
  process.exit(1);
}
console.log(`hover text: every icon-only button and unlabelled select in ${root} has a title`);
