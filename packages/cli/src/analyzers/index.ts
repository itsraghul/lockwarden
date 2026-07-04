import { agentHooksAnalyzer } from './agent-hooks.ts';
import { bindingGypAnalyzer } from './binding-gyp.ts';
import { depIntroductionAnalyzer } from './dep-introduction.ts';
import { ideTasksAnalyzer } from './ide-tasks.ts';
import { lifecycleScriptsAnalyzer } from './lifecycle-scripts.ts';
import { obfuscationAnalyzer } from './obfuscation.ts';
import { phantomDepsAnalyzer } from './phantom-deps.ts';
import { sizeDeltaAnalyzer } from './size-delta.ts';
import type { Analyzer } from './types.ts';

/** All 8 corpus-born analyzers, in LW001..LW008 order. */
export const ALL_ANALYZERS: Analyzer[] = [
  lifecycleScriptsAnalyzer,
  bindingGypAnalyzer,
  agentHooksAnalyzer,
  ideTasksAnalyzer,
  sizeDeltaAnalyzer,
  depIntroductionAnalyzer,
  obfuscationAnalyzer,
  phantomDepsAnalyzer,
];

export { agentHooksAnalyzer } from './agent-hooks.ts';
export { bindingGypAnalyzer } from './binding-gyp.ts';
export { depIntroductionAnalyzer, isPatchBump } from './dep-introduction.ts';
export { ideTasksAnalyzer } from './ide-tasks.ts';
export { lifecycleScriptsAnalyzer } from './lifecycle-scripts.ts';
export { OBFUSCATION_CUTOFFS, obfuscationAnalyzer } from './obfuscation.ts';
export { phantomDepsAnalyzer } from './phantom-deps.ts';
export { sizeDeltaAnalyzer } from './size-delta.ts';
