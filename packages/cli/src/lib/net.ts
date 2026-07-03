import { OfflineViolationError } from '../exit.js';

/**
 * THE ONLY network module. Every byte lockwarden ever fetches flows through
 * request() — no other file may reference fetch (enforced by
 * test/unit/net-chokepoint.test.ts). Network use is allowed ONLY for
 * registry tarball fetches during --diff/--deep delta comparison.
 *
 * LOCKWARDEN_REGISTRY exists for self-hosted registries and for tests;
 * lockwarden itself never phones home anywhere.
 */

let offline = false;

export function setOffline(value: boolean): void {
  offline = value;
}

export function isOffline(): boolean {
  return offline;
}

export function registryBase(): string {
  return process.env.LOCKWARDEN_REGISTRY ?? 'https://registry.npmjs.org';
}

export async function request(url: string): Promise<Response> {
  if (offline) {
    throw new OfflineViolationError(url);
  }
  return await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'lockwarden (local-first; no telemetry)' },
  });
}
