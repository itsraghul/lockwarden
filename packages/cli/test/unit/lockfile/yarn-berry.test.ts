import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../src/lockfile/types.js';
import { parseYarnBerry } from '../../../src/lockfile/yarn-berry.js';

const CTX = { lockfilePath: '/test/yarn.lock' };

const BASIC = `
__metadata:
  version: 8
  cacheKey: 10c0

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
  dependencies:
    lodash: "npm:^4.17.21"
    tslib: "npm:^2.6.0"
  languageName: unknown
  linkType: soft

"lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
  checksum: 10c0/abc123
  languageName: node
  linkType: hard

"tslib@npm:^2.6.0, tslib@npm:^2.5.0":
  version: 2.6.2
  resolution: "tslib@npm:2.6.2"
  checksum: 10c0/def456
  dependencies:
    lodash: "npm:^4.17.21"
  languageName: node
  linkType: hard
`;

describe('parseYarnBerry', () => {
  it('detects __metadata and parses descriptors with npm: protocol', () => {
    const graph = parseYarnBerry(BASIC, CTX);

    expect(graph.lockfileType).toBe('yarn-berry');
    expect(graph.lockfileVersion).toBe('8');
    // the workspace root is ROOT, not a package
    expect([...graph.packages.keys()].sort()).toEqual(['lodash@4.17.21', 'tslib@2.6.2']);

    const tslib = graph.packages.get('tslib@2.6.2');
    expect(tslib?.integrity).toBe('10c0/def456');
    expect(tslib?.locators).toContain('tslib@npm:2.6.2');
    expect(tslib?.locators).toContain('tslib@npm:^2.5.0');

    // root edges from the workspace entry; npm: prefix stripped for matching
    const rootEdges = graph.edges.filter((e) => e.from === ROOT);
    expect(rootEdges.map((e) => e.to).sort()).toEqual(['lodash@4.17.21', 'tslib@2.6.2']);
    // package-to-package edge
    expect(graph.edges.some((e) => e.from === 'tslib@2.6.2' && e.to === 'lodash@4.17.21')).toBe(
      true,
    );
  });

  it('classifies root dev edges via the project manifest', () => {
    const graph = parseYarnBerry(BASIC, {
      ...CTX,
      rootManifest: {
        dependencies: { lodash: '^4.17.21' },
        devDependencies: { tslib: '^2.6.0' },
      },
    });
    expect(graph.packages.get('tslib@2.6.2')?.dev).toBe(true);
    // lodash is also a prod dep of tslib's tree? no — lodash is prod at root
    expect(graph.packages.get('lodash@4.17.21')?.dev).toBe(false);
  });

  it('unwraps patch: descriptors down to the inner npm descriptor', () => {
    const content = `
__metadata:
  version: 8

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
  dependencies:
    typescript: "patch:typescript@npm%3A5.3.3#optional!builtin<compat/typescript>"

"typescript@npm:5.3.3":
  version: 5.3.3
  resolution: "typescript@npm:5.3.3"
  checksum: 10c0/ts533

"typescript@patch:typescript@npm%3A5.3.3#optional!builtin<compat/typescript>":
  version: 5.3.3
  resolution: "typescript@patch:typescript@npm%3A5.3.3#optional!builtin<compat/typescript>::version=5.3.3&hash=abc"
  checksum: 10c0/ts533patched
`;
    const graph = parseYarnBerry(content, CTX);
    expect(graph.packages.has('typescript@5.3.3')).toBe(true);
    expect(graph.edges.some((e) => e.from === ROOT && e.to === 'typescript@5.3.3')).toBe(true);
    expect(graph.warnings).toEqual([]);
  });

  it('records a warning for unresolvable patch descriptors', () => {
    const content = `
__metadata:
  version: 8

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
  dependencies:
    weird: "patch:%ZZbroken#x"
`;
    const graph = parseYarnBerry(content, CTX);
    expect(graph.warnings.some((w) => w.includes('patch'))).toBe(true);
  });

  it('throws ExecError when __metadata is missing', () => {
    expect(() => parseYarnBerry('foo: bar\n', CTX)).toThrowError(/__metadata/);
  });
});
