import {
  type Analyzer,
  type PackageArtifact,
  type Signal,
  excerpt,
} from '../../../packages/cli/src/analyzers/types.ts';
import { pkgRef, textOf } from './shared.ts';

/**
 * LW004 — IDE task surface shipped inside a package: .vscode/tasks.json
 * (metrics.folderOpen=1 when it auto-runs on folder open — the dangerous
 * variant), .vscode/settings.json flipping task.allowAutomaticTasks, and
 * JetBrains .idea/runConfigurations.
 */

interface IdeHit {
  path: string;
  reason: string;
  folderOpen: number;
}

async function ideSurface(pkg: PackageArtifact): Promise<IdeHit[]> {
  const hits: IdeHit[] = [];

  const tasks = pkg.files.get('.vscode/tasks.json');
  if (tasks !== undefined) {
    const text = await textOf(tasks);
    const folderOpen = text.includes('"runOn"') && text.includes('"folderOpen"') ? 1 : 0;
    hits.push({
      path: tasks.path,
      reason:
        folderOpen === 1
          ? 'VS Code tasks.json with runOn: folderOpen (auto-executes when the folder is opened)'
          : 'VS Code tasks.json shipped inside a package',
      folderOpen,
    });
  }

  const settings = pkg.files.get('.vscode/settings.json');
  if (settings !== undefined) {
    const text = await textOf(settings);
    if (text.includes('task.allowAutomaticTasks')) {
      hits.push({
        path: settings.path,
        reason: 'VS Code settings.json toggles task.allowAutomaticTasks',
        folderOpen: 0,
      });
    }
  }

  for (const path of pkg.files.keys()) {
    if (path.startsWith('.idea/runConfigurations')) {
      hits.push({
        path,
        reason: 'JetBrains run configuration shipped inside a package',
        folderOpen: 0,
      });
    }
  }

  return hits;
}

export const ideTasksAnalyzer: Analyzer = {
  id: 'ide-tasks',
  scope: 'package',
  needsPrevious: false,
  needsProject: false,
  async analyze(ctx) {
    const signals: Signal[] = [];
    const current = await ideSurface(ctx.pkg);
    if (current.length === 0) return signals;
    const previousPaths =
      ctx.previous === undefined
        ? undefined
        : new Set((await ideSurface(ctx.previous)).map((h) => h.path));

    for (const hit of current) {
      const entry = ctx.pkg.files.get(hit.path);
      const snippet =
        entry !== undefined && entry.size <= 4096 ? excerpt(await textOf(entry)) : undefined;
      signals.push({
        analyzer: 'ide-tasks',
        code: 'LW004-IDE-TASK',
        kind: 'absolute',
        package: pkgRef(ctx.pkg),
        evidence: { file: hit.path, excerpt: snippet, detail: hit.reason },
        metrics: { folderOpen: hit.folderOpen },
      });
      if (previousPaths !== undefined && !previousPaths.has(hit.path)) {
        signals.push({
          analyzer: 'ide-tasks',
          code: 'LW004D-IDE-TASK-INTRODUCED',
          kind: 'delta',
          package: pkgRef(ctx.pkg),
          evidence: {
            file: hit.path,
            excerpt: snippet,
            detail: `IDE task surface is NEW in ${ctx.pkg.version} (absent in ${ctx.previous?.version}): ${hit.reason}`,
          },
          metrics: { folderOpen: hit.folderOpen },
        });
      }
    }
    return signals;
  },
};
