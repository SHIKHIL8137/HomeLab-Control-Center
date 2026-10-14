export type Freshness = 'current' | 'stale' | 'unavailable';

/** A reading is current for 2.5 polling intervals; after that it is stale, never "healthy". */
export const STALE_AFTER_INTERVALS = 2.5;

export function freshness(
  collectedAtMs: number | null,
  nowMs: number,
  intervalMs: number,
): Freshness {
  if (collectedAtMs === null) return 'unavailable';
  return nowMs - collectedAtMs <= intervalMs * STALE_AFTER_INTERVALS ? 'current' : 'stale';
}
