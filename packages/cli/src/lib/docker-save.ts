/**
 * docker-save tarball layout support for `scan --image` / scan of an exported
 * image tar. v1 policy (spec §2.4): extract layers via `docker save` tarball
 * parsing — no daemon API dependency, ever.
 *
 * Two on-disk layouts exist and both are supported:
 *   - classic docker save: manifest.json + <layer-dir>/layer.tar per layer
 *   - OCI layout:          manifest.json + blobs/sha256/<digest> per layer
 * manifest.json is the same shape in both: [{ Config, Layers: [paths...] }].
 */

/** Minimal archive entry shape shared by the tar and zip readers. */
export interface ArchiveEntry {
  path: string;
  size: number;
  data: Buffer;
}

interface ManifestImage {
  Config?: string;
  Layers?: string[];
}

function parseManifest(entries: ArchiveEntry[]): ManifestImage[] | undefined {
  const manifest = entries.find((e) => e.path === 'manifest.json');
  if (manifest === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(manifest.data.toString('utf8'));
    if (Array.isArray(parsed)) return parsed as ManifestImage[];
  } catch {
    // not a docker-save manifest — caller treats the tar as a plain artifact
  }
  return undefined;
}

/**
 * True when a tar's root looks like a docker-save archive: a manifest.json
 * that parses to [{ Layers: [...] }]. Used to sniff plain tars — a tar that
 * merely CONTAINS a file named manifest.json without the docker shape is
 * treated as an ordinary artifact.
 */
export function isDockerSaveLayout(entries: ArchiveEntry[]): boolean {
  const images = parseManifest(entries);
  return images?.some((img) => Array.isArray(img.Layers)) ?? false;
}

/** Normalize a manifest Layers path for lookup against archive entry paths. */
function normalizeLayerPath(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  // OCI manifests may reference blobs as "blobs/sha256:<digest>"; on disk the
  // separator is a slash.
  return out.replace('sha256:', 'sha256/');
}

/**
 * The image's layer tar buffers IN ORDER (base first). Multi-image archives
 * (several tags saved at once) use the first manifest entry — `scan` audits
 * one image per artifact.
 */
export function layersOf(entries: ArchiveEntry[]): Buffer[] {
  const images = parseManifest(entries);
  const image = images?.[0];
  if (image === undefined || !Array.isArray(image.Layers)) {
    throw new Error('not a docker-save archive: manifest.json missing or has no Layers');
  }
  const byPath = new Map<string, ArchiveEntry>();
  for (const entry of entries) byPath.set(entry.path, entry);

  return image.Layers.map((layerPath) => {
    const normalized = normalizeLayerPath(layerPath);
    const entry = byPath.get(normalized) ?? byPath.get(layerPath);
    if (entry === undefined) {
      throw new Error(`docker-save layer not found in archive: ${layerPath}`);
    }
    return entry.data;
  });
}

const WHITEOUT_PREFIX = '.wh.';
const OPAQUE_WHITEOUT = '.wh..wh..opq';

function deleteSubtree(fs: Map<string, ArchiveEntry>, dir: string): void {
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const path of [...fs.keys()]) {
    if (prefix === '' || path.startsWith(prefix)) fs.delete(path);
  }
}

/**
 * Overlay the decoded layers into the image's final filesystem view.
 * Later layers win; whiteout files (`.wh.<name>`) delete the shadowed path
 * (file or subtree) and opaque whiteouts (`.wh..wh..opq`) clear everything
 * beneath their directory from earlier layers. Whiteout markers themselves
 * never appear in the result.
 */
export function applyLayers(layers: ArchiveEntry[][]): Map<string, ArchiveEntry> {
  const fs = new Map<string, ArchiveEntry>();
  for (const layer of layers) {
    for (const entry of layer) {
      const slash = entry.path.lastIndexOf('/');
      const dir = slash === -1 ? '' : entry.path.slice(0, slash);
      const base = slash === -1 ? entry.path : entry.path.slice(slash + 1);

      if (base === OPAQUE_WHITEOUT) {
        deleteSubtree(fs, dir);
        continue;
      }
      if (base.startsWith(WHITEOUT_PREFIX)) {
        const targetBase = base.slice(WHITEOUT_PREFIX.length);
        const target = dir === '' ? targetBase : `${dir}/${targetBase}`;
        fs.delete(target);
        deleteSubtree(fs, target);
        continue;
      }
      fs.set(entry.path, entry);
    }
  }
  return fs;
}
