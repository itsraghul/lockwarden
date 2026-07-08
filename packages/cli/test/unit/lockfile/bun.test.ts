import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBun, stripJsonc } from '../../../src/lockfile/bun.js';
import { ROOT } from '../../../src/lockfile/types.js';
import { fixtureDir } from './helpers.js';

const CTX = { lockfilePath: '/test/bun.lock' };

describe('parseBun v1', () => {
  it('parses the bun-basic fixture (real `bun install` output, JSONC)', () => {
    const dir = fixtureDir('bun-basic');
    const graph = parseBun(readFileSync(join(dir, 'bun.lock'), 'utf8'), {
      lockfilePath: join(dir, 'bun.lock'),
    });

    expect(graph.lockfileType).toBe('bun');
    expect(graph.lockfileVersion).toBe('1');
    // 22 entries in the lockfile map (bun's own count of 23 includes the
    // root workspace); "send/debug" and "send/debug/ms" are DIFFERENT
    // versions of hoisted packages, so all 22 keys are distinct.
    expect(graph.packages.size).toBe(22);
    expect(graph.warnings).toEqual([]);

    // Nesting produces two resolved debug versions with distinct keys.
    expect(graph.packages.has('debug@4.4.3')).toBe(true);
    expect(graph.packages.has('debug@2.6.9')).toBe(true);
    expect(graph.packages.get('debug@2.6.9')?.locators).toEqual(['send/debug']);

    // Edge resolution follows the nesting: send -> debug@2.6.9 (nested),
    // root -> debug@4.4.3 (hoisted); the nested debug uses the nested ms.
    expect(graph.edges.some((e) => e.from === 'send@0.18.0' && e.to === 'debug@2.6.9')).toBe(true);
    expect(graph.edges.some((e) => e.from === ROOT && e.to === 'debug@4.4.3')).toBe(true);
    expect(graph.edges.some((e) => e.from === 'debug@2.6.9' && e.to === 'ms@2.0.0')).toBe(true);
    expect(graph.edges.some((e) => e.from === 'debug@4.4.3' && e.to === 'ms@2.1.3')).toBe(true);

    // Root edge classification from the "" workspace.
    const rootDev = graph.edges.find((e) => e.from === ROOT && e.to === 'left-pad@1.3.0');
    expect(rootDev?.type).toBe('dev');
    expect(rootDev?.range).toBe('^1.3.0');
    expect(graph.packages.get('left-pad@1.3.0')?.dev).toBe(true);
    const rootOptional = graph.edges.find((e) => e.from === ROOT && e.to === 'fsevents@2.3.3');
    expect(rootOptional?.type).toBe('optional');
    expect(graph.packages.get('fsevents@2.3.3')?.optional).toBe(true);
    expect(graph.packages.get('send@0.18.0')?.dev).toBe(false);

    // Integrity captured from the tuple tail.
    expect(graph.packages.get('ms@2.1.3')?.integrity).toMatch(/^sha512-6Flz/);
  });

  it('skips workspace stubs with a single warning and keeps registry deps', () => {
    const content = `{
      "lockfileVersion": 1,
      "workspaces": {
        "": { "name": "ws-root", "dependencies": { "ee-first": "1.1.1" } },
        "packages/inner": { "name": "@ws/inner", "version": "0.1.0" }
      },
      "packages": {
        "@ws/inner": ["@ws/inner@workspace:packages/inner"],
        "ee-first": ["ee-first@1.1.1", "", {}, "sha512-abc"],
        "ms": ["ms@2.1.3", "", {}, "sha512-def"],
      }
    }`;
    const graph = parseBun(content, CTX);
    expect(graph.packages.has('ee-first@1.1.1')).toBe(true);
    expect(graph.packages.has('ms@2.1.3')).toBe(true);
    expect([...graph.packages.keys()].some((key) => key.includes('workspace:'))).toBe(false);
    expect(graph.warnings).toEqual([
      'workspace packages present; their dependency edges are not modeled',
    ]);
  });

  it('resolves scoped-package nesting paths (@scope/name is one segment)', () => {
    const content = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "x", "dependencies": { "@scope/a": "^1.0.0" } } },
      "packages": {
        "@scope/a": ["@scope/a@1.0.0", "", { "dependencies": { "b": "^2.0.0" } }, "sha512-a"],
        "@scope/a/b": ["b@2.0.0", "", {}, "sha512-b"],
        "b": ["b@3.0.0", "", {}, "sha512-c"],
      }
    }`;
    const graph = parseBun(content, CTX);
    // @scope/a must see its NESTED b@2.0.0, not the hoisted b@3.0.0.
    expect(graph.edges.some((e) => e.from === '@scope/a@1.0.0' && e.to === 'b@2.0.0')).toBe(true);
    expect(graph.edges.some((e) => e.from === '@scope/a@1.0.0' && e.to === 'b@3.0.0')).toBe(false);
  });

  it('falls back to the root manifest when the "" workspace is absent', () => {
    const content = `{
      "lockfileVersion": 0,
      "packages": { "ms": ["ms@2.1.3", "", {}, "sha512-x"] }
    }`;
    const graph = parseBun(content, {
      lockfilePath: '/test/bun.lock',
      rootManifest: { dependencies: { ms: '^2.1.3' } },
    });
    expect(graph.edges).toEqual([{ from: ROOT, to: 'ms@2.1.3', type: 'prod', range: '^2.1.3' }]);
  });

  it('invalid JSONC is an ExecError (exit 2)', () => {
    expect(() => parseBun('{ not json', CTX)).toThrow(/invalid JSONC/);
    expect(() => parseBun('[1, 2]', CTX)).toThrow(/expected a JSONC object/);
  });
});

describe('stripJsonc', () => {
  it('removes trailing commas, line and block comments — but never inside strings', () => {
    const input = `{
      // line comment
      "a": "keep // this, and this,", /* block */
      "b": [1, 2, /* mid */ 3,],
      "c": { "d": "e", },
    }`;
    const parsed = JSON.parse(stripJsonc(input));
    expect(parsed).toEqual({ a: 'keep // this, and this,', b: [1, 2, 3], c: { d: 'e' } });
  });

  it('handles escaped quotes inside strings', () => {
    expect(JSON.parse(stripJsonc('{ "a": "quote \\" comma, }", }'))).toEqual({
      a: 'quote " comma, }',
    });
  });
});
