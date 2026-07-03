/**
 * Corpus-side analyzer registry. Analyzers are BORN here (Phase 1) against
 * real tarballs; once the separation report gates their weights they are
 * promoted verbatim into packages/cli/src/analyzers/ and re-exported from
 * there so the corpus keeps re-validating exactly what ships.
 */
export type {
  Analyzer,
  AnalyzerContext,
  AnalyzerId,
  PackageArtifact,
  Signal,
} from '../../packages/cli/src/analyzers/types.ts';
