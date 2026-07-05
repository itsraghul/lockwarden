// Generates dist/llms-full.txt: every docs page as plain markdown, concatenated
// in sidebar order, with canonical URLs. Runs after `astro build` (see the
// site package.json build script) so it can never go stale relative to the
// published pages.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(here, '../src/content/docs');
const distDir = resolve(here, '../dist');
const SITE = 'https://lockwarden.dev';

// Mirror of the sidebar order in astro.config.mjs (slugs without leading slash).
const ORDER = [
  'index',
  'getting-started',
  'quickstart-ci',
  'guides/ci-recipes',
  'guides/incident-response',
  'guides/dependency-review',
  'commands/index',
  'commands/check',
  'commands/audit',
  'commands/drift',
  'commands/scan',
  'commands/secrets',
  'github-action',
  'reference/json-output',
  'reference/exit-codes',
  'scoring',
  'trust-model',
  'incidents',
  'project/comparison',
  'project/architecture-decisions',
  'project/contributing',
];

async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full)));
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function slugOf(file) {
  return relative(docsDir, file)
    .replace(/\.mdx?$/, '')
    .replaceAll('\\', '/');
}

function urlOf(slug) {
  if (slug === 'index') return `${SITE}/`;
  const path = slug.endsWith('/index') ? slug.slice(0, -'/index'.length) : slug;
  return `${SITE}/${path}/`;
}

/** Split frontmatter from body; return { meta: {title, description}, body }. */
function parse(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  const meta = {};
  let body = source;
  if (match) {
    body = source.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^(title|description):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body };
}

/**
 * Dedent content that was nested inside JSX components (Tabs/Card indent by
 * 4 spaces) without touching indentation *inside* fenced code blocks —
 * fence-aware so JSON/YAML samples keep their own nesting.
 */
function dedentComponents(body) {
  const out = [];
  let inFence = false;
  let fenceDedent = 0;
  for (const line of body.split('\n')) {
    if (inFence) {
      const stripped =
        fenceDedent > 0 && line.startsWith(' '.repeat(fenceDedent))
          ? line.slice(fenceDedent)
          : line;
      out.push(stripped);
      if (stripped.trimStart().startsWith('```')) inFence = false;
      continue;
    }
    const fence = /^(\s*)```/.exec(line);
    if (fence) {
      inFence = true;
      fenceDedent = fence[1].length >= 4 ? fence[1].length : 0;
      out.push(fenceDedent > 0 ? line.slice(fenceDedent) : line);
      continue;
    }
    out.push(/^ {4,}\S/.test(line) ? line.slice(4) : line);
  }
  return out.join('\n');
}

/** Strip MDX-only syntax so the output is plain markdown. */
function toPlainMarkdown(body) {
  const stripped = body
    // import statements
    .replace(/^import\s.+from\s+['"].+['"];?\s*$/gm, '')
    // JSX component tags (Card, CardGrid, Tabs, TabItem, …) — keep inner content
    .replace(/^\s*<\/?[A-Z][A-Za-z]*(\s[^>]*)?\/?>\s*$/gm, '')
    // inline JSX self-closing/opening tags left mid-line
    .replace(/<\/?(Card|CardGrid|Tabs|TabItem|Steps|Aside)(\s[^>]*)?>/g, '');
  return (
    dedentComponents(stripped)
      // relative doc links → absolute site links
      .replace(/\]\(\/(?!\/)/g, `](${SITE}/`)
      // collapse 3+ blank lines
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

const files = await collect(docsDir);
const bySlug = new Map(files.map((f) => [slugOf(f), f]));

// Sidebar order first, then anything new that hasn't been added to ORDER yet.
const slugs = [
  ...ORDER.filter((s) => bySlug.has(s)),
  ...[...bySlug.keys()].filter((s) => !ORDER.includes(s)).sort(),
];

const parts = [
  '# lockwarden — full documentation',
  '',
  '> Audit what your npm dependency tree can execute — and answer "am I hit?" in',
  '> seconds during supply-chain incidents. Local-first, zero telemetry, zero accounts.',
  '',
  `This file concatenates every page of ${SITE} as plain markdown.`,
  `A curated link index lives at ${SITE}/llms.txt`,
  '',
];

for (const slug of slugs) {
  const file = bySlug.get(slug);
  const { meta, body } = parse(await readFile(file, 'utf8'));
  parts.push('---', '');
  parts.push(`# ${meta.title ?? slug}`, '');
  parts.push(`URL: ${urlOf(slug)}`);
  if (meta.description) parts.push(`Summary: ${meta.description}`);
  parts.push('', toPlainMarkdown(body), '');
}

await writeFile(join(distDir, 'llms-full.txt'), `${parts.join('\n')}\n`);
console.log(`llms-full.txt: ${slugs.length} pages → ${join(distDir, 'llms-full.txt')}`);
