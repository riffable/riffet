import { describe, expect, it } from 'vitest';
import { autoGranularity, boundedGranularity, bucketEdges, bucketIndex, bucketStart, localDate, previousDate, validZone } from './buckets.js';

const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);

describe('stats buckets', () => {
  it('makes the spring-forward day 23 hours and the fall-back day 25 hours long', () => {
    const zone = 'America/New_York';
    const spring = bucketEdges(at('2026-03-07T12:00:00Z'), at('2026-03-10T12:00:00Z'), zone, 'day');
    const march8 = spring.findIndex(edge => localDate(edge, zone) === '2026-03-08');
    expect(spring[march8 + 1]! - spring[march8]!).toBe(23 * HOUR);
    const fall = bucketEdges(at('2026-10-31T12:00:00Z'), at('2026-11-03T12:00:00Z'), zone, 'day');
    const november1 = fall.findIndex(edge => localDate(edge, zone) === '2026-11-01');
    expect(fall[november1 + 1]! - fall[november1]!).toBe(25 * HOUR);
  });

  it('starts weeks on Monday in the requested zone', () => {
    // Thursday 2026-10-08 in Shanghai; that week's Monday midnight is 2026-10-04T16:00Z.
    expect(new Date(bucketStart(at('2026-10-08T03:00:00Z'), 'Asia/Shanghai', 'week')).toISOString()).toBe('2026-10-04T16:00:00.000Z');
  });

  it('cuts hours on local hour starts for half-hour offsets', () => {
    expect(new Date(bucketStart(at('2026-10-08T10:10:00Z'), 'Asia/Kolkata', 'hour')).toISOString()).toBe('2026-10-08T09:30:00.000Z');
  });

  it('starts months on the local first day', () => {
    expect(new Date(bucketStart(at('2026-10-08T03:00:00Z'), 'Asia/Shanghai', 'month')).toISOString()).toBe('2026-09-30T16:00:00.000Z');
  });

  it('falls back to UTC for a zone Intl does not know', () => {
    expect(validZone('Not/AZone')).toBe('UTC');
    expect(validZone(undefined)).toBe('UTC');
    expect(validZone('Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('finds the bucket of an instant', () => {
    const edges = [10, 20, 30];
    expect(bucketIndex(edges, 5)).toBe(-1);
    expect(bucketIndex(edges, 20)).toBe(1);
    expect(bucketIndex(edges, 99)).toBe(2);
  });

  it('chooses and bounds granularity by window length', () => {
    expect(autoGranularity(0, 24 * HOUR)).toBe('hour');
    expect(autoGranularity(0, 30 * 24 * HOUR)).toBe('day');
    expect(autoGranularity(0, 200 * 24 * HOUR)).toBe('week');
    expect(autoGranularity(0, 900 * 24 * HOUR)).toBe('month');
    expect(boundedGranularity(0, 365 * 24 * HOUR, 'hour')).toBe('day');
  });

  it('steps calendar dates without a zone', () => {
    expect(previousDate('2026-03-01')).toBe('2026-02-28');
  });
});
