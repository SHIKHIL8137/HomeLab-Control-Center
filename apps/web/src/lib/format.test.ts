import { describe, expect, it } from 'vitest';
import { formatBytes, formatDecimalBytes, formatDuration, percent, timeAgo } from './format';

describe('format', () => {
  it('formats binary bytes and shows a dash for missing values', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.0 GiB');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });
  it('formats decimal disk sizes', () => {
    expect(formatDecimalBytes(458e9)).toBe('458.0 GB');
    expect(formatDecimalBytes(2e12)).toBe('2.00 TB');
  });
  it('formats durations and ages', () => {
    expect(formatDuration(70 * 3600)).toBe('2d 22h');
    expect(formatDuration(125)).toBe('2m 5s');
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(timeAgo('2026-10-14T11:59:30Z', now)).toBe('30s ago');
    expect(timeAgo('2026-10-14T09:00:00Z', now)).toBe('3h ago');
    expect(timeAgo(null, now)).toBe('never');
  });
  it('formats percentages', () => {
    expect(percent(12.345)).toBe('12.3%');
    expect(percent(null)).toBe('—');
  });
});
