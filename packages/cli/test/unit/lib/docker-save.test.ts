import { describe, expect, it } from 'vitest';
import {
  type ArchiveEntry,
  applyLayers,
  isDockerSaveLayout,
  layersOf,
} from '../../../src/lib/docker-save.js';

function e(path: string, data: string | Buffer = ''): ArchiveEntry {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return { path, size: buf.length, data: buf };
}

function manifest(layers: string[]): ArchiveEntry {
  return e('manifest.json', JSON.stringify([{ Config: 'config.json', Layers: layers }]));
}

describe('isDockerSaveLayout', () => {
  it('recognizes a manifest.json with Layers', () => {
    expect(isDockerSaveLayout([manifest(['l1/layer.tar']), e('l1/layer.tar', 'x')])).toBe(true);
  });

  it('rejects a tar that merely contains an unrelated manifest.json', () => {
    expect(isDockerSaveLayout([e('manifest.json', '{"not":"docker"}')])).toBe(false);
    expect(isDockerSaveLayout([e('manifest.json', 'not json at all')])).toBe(false);
    expect(isDockerSaveLayout([e('other.json', '[]')])).toBe(false);
  });
});

describe('layersOf', () => {
  it('returns layer buffers in manifest order for <dir>/layer.tar paths', () => {
    const entries = [
      e('b/layer.tar', 'SECOND'),
      manifest(['a/layer.tar', 'b/layer.tar']),
      e('a/layer.tar', 'FIRST'),
    ];
    expect(layersOf(entries).map((b) => b.toString('utf8'))).toEqual(['FIRST', 'SECOND']);
  });

  it('resolves OCI blobs/sha256/<hash> paths, including sha256: separators', () => {
    const entries = [
      manifest(['blobs/sha256/aaa', 'blobs/sha256:bbb']),
      e('blobs/sha256/aaa', 'A'),
      e('blobs/sha256/bbb', 'B'),
    ];
    expect(layersOf(entries).map((b) => b.toString('utf8'))).toEqual(['A', 'B']);
  });

  it('throws when a manifest layer is missing from the archive', () => {
    expect(() => layersOf([manifest(['gone/layer.tar'])])).toThrow(
      /layer not found in archive: gone\/layer.tar/,
    );
  });

  it('throws when manifest.json is absent or shapeless', () => {
    expect(() => layersOf([e('config.json', '{}')])).toThrow(/manifest.json missing/);
    expect(() => layersOf([e('manifest.json', '[{}]')])).toThrow(/no Layers/);
  });
});

describe('applyLayers — overlay semantics', () => {
  it('later layers win for the same path', () => {
    const fs = applyLayers([
      [e('app/config.js', 'v1'), e('app/other.js', 'keep')],
      [e('app/config.js', 'v2')],
    ]);
    expect(fs.get('app/config.js')?.data.toString('utf8')).toBe('v2');
    expect(fs.get('app/other.js')?.data.toString('utf8')).toBe('keep');
  });

  it('whiteout files delete the shadowed file and never appear themselves', () => {
    const fs = applyLayers([[e('app/secret.js', 'x')], [e('app/.wh.secret.js')]]);
    expect(fs.has('app/secret.js')).toBe(false);
    expect([...fs.keys()]).toEqual([]);
  });

  it('whiteout of a directory deletes the whole subtree', () => {
    const fs = applyLayers([
      [e('node_modules/evil/package.json', '{}'), e('node_modules/evil/index.js', 'x')],
      [e('node_modules/.wh.evil'), e('node_modules/ok/index.js', 'y')],
    ]);
    expect([...fs.keys()]).toEqual(['node_modules/ok/index.js']);
  });

  it('opaque whiteouts clear everything beneath the directory from earlier layers', () => {
    const fs = applyLayers([
      [e('app/a.js', 'old'), e('app/deep/b.js', 'old'), e('root.js', 'keep')],
      [e('app/.wh..wh..opq'), e('app/fresh.js', 'new')],
    ]);
    expect([...fs.keys()].sort()).toEqual(['app/fresh.js', 'root.js']);
  });

  it('a file re-added after a whiteout in a later layer survives', () => {
    const fs = applyLayers([[e('a/x.js', 'v1')], [e('a/.wh.x.js')], [e('a/x.js', 'v3')]]);
    expect(fs.get('a/x.js')?.data.toString('utf8')).toBe('v3');
  });
});
