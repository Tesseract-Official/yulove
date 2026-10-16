import { describe, expect, it } from 'vitest';
import { mapLimit } from './concurrency.js';

describe('mapLimit', () => {
  it('keeps results in input order', async () => {
    const out = await mapLimit([30, 5, 15], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 5, 15]);
  });

  it('never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    await mapLimit(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 2));
        running -= 1;
      },
    );
    expect(peak).toBe(4);
  });

  it('handles an empty list', async () => {
    await expect(mapLimit([], 5, async (x) => x)).resolves.toEqual([]);
  });

  it('rejects when a call fails', async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
