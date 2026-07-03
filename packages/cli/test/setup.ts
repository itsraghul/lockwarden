/**
 * Global unit-test setup: tests must run fully offline. Any code path that
 * reaches for the network during a test fails immediately and loudly.
 *
 * This is layer 1 of the offline guarantee (in-process). Layer 2 is
 * structural: lib/net.ts is the only module allowed to reference fetch,
 * enforced by test/unit/net-chokepoint.test.ts.
 */
const offlineFetch: typeof fetch = () => {
  throw new Error(
    'Network access attempted during tests. All tests must run offline — ' +
      'use fixtures instead, or route through lib/net.ts and stub it.',
  );
};

globalThis.fetch = offlineFetch;
