// PROMOTED to packages/cli/src/analyzers/ (build-order Phase 4). This shim keeps
// the corpus validating exactly what ships — do not reintroduce logic here.
//
// PRE-PROMOTION EXCEPTION: native-binary is corpus-born (build-order rule —
// analyzers are written HERE first, calibrated, then promoted). The local
// ALL_ANALYZERS below shadows the shipped one to append the prototype; it
// reverts to a pure `export *` shim when native-binary is promoted.
import { ALL_ANALYZERS as SHIPPED_ANALYZERS } from '../../../packages/cli/src/analyzers/index.ts';
import { nativeBinaryAnalyzer } from './native-binary.ts';

export * from '../../../packages/cli/src/analyzers/index.ts';
export { nativeBinaryAnalyzer };
export const ALL_ANALYZERS = [...SHIPPED_ANALYZERS, nativeBinaryAnalyzer];
