import { describe, expect, it } from 'vitest';
import { shouldSend } from '../src/dedup.js';

const NOW = '2026-07-18T12:00:00.000Z';

describe('shouldSend', () => {
  it('允許沒有近期紀錄的通知', () => {
    expect(shouldSend({ eventType: 'sync_failed', dedupKey: 'sync:2026-07-18', cooldownMinutes: 360 }, [], NOW)).toBe(true);
  });

  it('同一 dedup_key 已發送過 → 不重發', () => {
    const recent = [{ dedupKey: 'card:c1:cycle:2026-07', sentAt: '2026-07-18T09:00:00.000Z' }];
    expect(
      shouldSend({ eventType: 'card_statement_upcoming', dedupKey: 'card:c1:cycle:2026-07', cooldownMinutes: 0 }, recent, NOW),
    ).toBe(false);
  });

  it('dedup_key 不同但仍在 cooldown 內 → 不重發', () => {
    const recent = [{ dedupKey: 'sync:2026-07-18T11:50', sentAt: '2026-07-18T11:50:00.000Z' }];
    expect(shouldSend({ eventType: 'sync_failed', dedupKey: 'sync:2026-07-18T12:00', cooldownMinutes: 360 }, recent, NOW)).toBe(
      false,
    );
  });

  it('超過 cooldown 後允許重發（即使 dedup_key 不同）', () => {
    const recent = [{ dedupKey: 'sync:2026-07-18T05:00', sentAt: '2026-07-18T05:00:00.000Z' }];
    expect(shouldSend({ eventType: 'sync_failed', dedupKey: 'sync:2026-07-18T12:00', cooldownMinutes: 360 }, recent, NOW)).toBe(
      true,
    );
  });

  it('cooldownMinutes=0 只看 dedup_key，不看時間', () => {
    const recent = [{ dedupKey: 'other-key', sentAt: NOW }];
    expect(shouldSend({ eventType: 'statement_ready', dedupKey: 'stmt:s1', cooldownMinutes: 0 }, recent, NOW)).toBe(true);
  });
});
