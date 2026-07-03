import {
  type Analyzer,
  type PackageArtifact,
  type Signal,
  excerpt,
} from '../../../packages/cli/src/analyzers/types.ts';
import { pkgRef, textOf } from './shared.ts';

/**
 * LW003 — AI-agent hook surface shipped inside a package: MCP manifests,
 * hook blocks, mcpServers declarations. A dependency has no business
 * configuring the *consumer's* coding agent.
 *
 * CORPUS TUNING (calibration v1): precision over recall. Bare presence of a
 * `.claude/`/`.cursor/` path is NOT flagged — maintainers routinely leak
 * their own inert agent config (e.g. resolve ships `.claude/notes.md` and a
 * hook-less `settings.local.json`), and flagging that produced a benign
 * Critical delta. We flag only files carrying EXECUTABLE agent intent:
 *   - MCP manifest filenames (mcp.json / *.mcp.json / mcp-manifest*)
 *   - any .json containing "mcpServers"
 *   - a .json under an agent config dir containing "hooks" or "SessionStart"
 */

const AGENT_CONFIG_DIRS = ['.claude/', '.cursor/', '.github/copilot'];

/** Only files this small get content-sniffed for mcpServers/hooks markers. */
const CONTENT_SCAN_MAX_BYTES = 1_000_000;

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

async function matchedFiles(pkg: PackageArtifact): Promise<Map<string, string>> {
  const hits = new Map<string, string>();
  for (const [path, entry] of pkg.files) {
    const base = basename(path);

    if (base === 'mcp.json' || path.endsWith('.mcp.json') || base.startsWith('mcp-manifest')) {
      hits.set(path, 'MCP manifest filename');
      continue;
    }

    if (!path.endsWith('.json') || entry.size > CONTENT_SCAN_MAX_BYTES) continue;
    const text = await textOf(entry);
    if (text.includes('"mcpServers"')) {
      hits.set(path, 'file declares mcpServers');
      continue;
    }
    const inAgentDir = AGENT_CONFIG_DIRS.some((p) => path.startsWith(p));
    if (inAgentDir && (text.includes('"hooks"') || text.includes('SessionStart'))) {
      hits.set(path, 'agent config with hooks/SessionStart block');
    }
  }
  return hits;
}

export const agentHooksAnalyzer: Analyzer = {
  id: 'agent-hooks',
  scope: 'package',
  needsPrevious: false,
  needsProject: false,
  async analyze(ctx) {
    const signals: Signal[] = [];
    const current = await matchedFiles(ctx.pkg);
    if (current.size === 0) return signals;
    const previous = ctx.previous === undefined ? undefined : await matchedFiles(ctx.previous);

    for (const [path, reason] of current) {
      const entry = ctx.pkg.files.get(path);
      let snippet: string | undefined;
      if (entry !== undefined && entry.size <= 4096) {
        snippet = excerpt(await textOf(entry));
      }
      signals.push({
        analyzer: 'agent-hooks',
        code: 'LW003-AGENT-HOOK',
        kind: 'absolute',
        package: pkgRef(ctx.pkg),
        evidence: { file: path, excerpt: snippet, detail: `AI-agent hook surface: ${reason}` },
      });
      if (previous !== undefined && !previous.has(path)) {
        signals.push({
          analyzer: 'agent-hooks',
          code: 'LW003D-AGENT-HOOK-INTRODUCED',
          kind: 'delta',
          package: pkgRef(ctx.pkg),
          evidence: {
            file: path,
            excerpt: snippet,
            detail: `AI-agent hook surface is NEW in ${ctx.pkg.version} (absent in ${ctx.previous?.version}): ${reason}`,
          },
        });
      }
    }
    return signals;
  },
};
