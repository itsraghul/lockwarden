/**
 * The analyzer contract, shared between the corpus calibration harness and
 * the CLI. Analyzers are born in corpus/src against real tarballs and
 * promoted here verbatim once the separation report gates their weights.
 *
 * HARD RULE: this module (and every analyzer) must have zero imports from
 * CLI internals — analyzers emit FACTS (signals), never severities. The
 * scoring engine maps (analyzer, kind) → weight via corpus-generated
 * weights, which is what keeps "weights provisional until corpus" true.
 */

export type AnalyzerId =
  | 'lifecycle-scripts'
  | 'binding-gyp'
  | 'agent-hooks'
  | 'ide-tasks'
  | 'size-delta'
  | 'dep-introduction'
  | 'obfuscation'
  | 'phantom-deps'
  | 'native-binary';

export interface FileEntry {
  /** posix path relative to the package root ("package/" prefix stripped) */
  path: string;
  size: number;
  /** lazy — tar entries are decoded on demand */
  read(): Promise<Buffer>;
}

/** A package's contents, independent of where they came from (registry tarball, dir, docker layer). */
export interface PackageArtifact {
  name: string;
  version: string;
  /** parsed package.json */
  manifest: Record<string, unknown>;
  files: Map<string, FileEntry>;
  totalSize: number;
}

/** Project-level context, needed only by phantom-deps in project mode. */
export interface ProjectContext {
  rootDir: string;
  /** the project's own source files (node_modules excluded) */
  sourceFiles: FileEntry[];
  /** direct deps declared in the project package.json: name → range */
  directDeps: Map<string, string>;
}

/** Minimal view of the lockfile graph an analyzer may need (tree-scoped analyzers). */
export interface GraphView {
  /** all resolved name@version keys in the tree */
  packages: ReadonlySet<string>;
}

/** Diff between a base lockfile and the current one (delta mode). */
export interface LockfileDiffView {
  /** packages whose resolved version changed: name → { from, to } */
  changed: Map<string, { from: string; to: string }>;
  /** name@version keys present now but not in base */
  added: ReadonlySet<string>;
  /** name@version keys present in base but not now */
  removed: ReadonlySet<string>;
}

export interface AnalyzerContext {
  pkg: PackageArtifact;
  /** previous version of the same package — present only in --diff/--deep delta mode */
  previous?: PackageArtifact;
  graph?: GraphView;
  graphDiff?: LockfileDiffView;
  project?: ProjectContext;
}

export type SignalKind = 'absolute' | 'delta';

export interface Signal {
  analyzer: AnalyzerId;
  /** stable rule id, e.g. "LW001-LIFECYCLE-PRESENT", "LW001D-LIFECYCLE-INTRODUCED" */
  code: string;
  kind: SignalKind;
  package: { name: string; version: string };
  evidence: {
    /** path inside the package */
    file?: string;
    /** ≤200 chars, defanged */
    excerpt?: string;
    /** human sentence */
    detail: string;
  };
  /** raw measurements for corpus tuning, e.g. { sizeRatio: 25.3, hexDensity: 0.41 } */
  metrics?: Record<string, number>;
}

export interface Analyzer {
  id: AnalyzerId;
  scope: 'package' | 'tree';
  /** size-delta: true — cannot run without the previous version */
  needsPrevious: boolean;
  /** phantom-deps project mode: true */
  needsProject: boolean;
  analyze(ctx: AnalyzerContext): Promise<Signal[]>;
}

/** Truncate an excerpt to the defanged 200-char evidence budget. */
export function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
