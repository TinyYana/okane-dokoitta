import { describe, expect, it } from 'vitest';
import {
  assertExpectedTransition,
  assertStatementTransition,
  assertStatusTransition,
  canTransitionStatus,
  TRANSACTION_STATUSES,
  type TransactionStatus,
} from '../src/index.js';

describe('交易狀態機：合法/非法轉移矩陣（DATA_MODEL §3.6）', () => {
  const legal: Array<[TransactionStatus, TransactionStatus]> = [
    ['draft', 'pending'],
    ['draft', 'cancelled'],
    ['expected', 'pending'],
    ['expected', 'cancelled'],
    ['pending', 'posted'],
    ['pending', 'cancelled'],
    ['posted', 'cancelled'],
    ['posted', 'disputed'],
  ];

  it('合法轉移全部通過', () => {
    for (const [from, to] of legal) {
      expect(() => assertStatusTransition(from, to), `${from}→${to}`).not.toThrow();
    }
  });

  it('矩陣其餘全部拒絕（含終態不可離開、不可倒退）', () => {
    const legalSet = new Set(legal.map(([f, t]) => `${f}→${t}`));
    for (const from of TRANSACTION_STATUSES) {
      for (const to of TRANSACTION_STATUSES) {
        if (from === to || legalSet.has(`${from}→${to}`)) continue;
        expect(canTransitionStatus(from, to), `${from}→${to} 應拒絕`).toBe(false);
      }
    }
  });

  it('釘死關鍵非法案例', () => {
    expect(() => assertStatusTransition('posted', 'pending')).toThrow(); // 不可倒退
    expect(() => assertStatusTransition('cancelled', 'posted')).toThrow(); // 終態
    expect(() => assertStatusTransition('draft', 'posted')).toThrow(); // 不可跳級
    expect(() => assertStatusTransition('expected', 'posted')).toThrow();
  });
});

describe('帳單狀態機：open → closed → due → paid', () => {
  it('合法路徑', () => {
    expect(() => assertStatementTransition('open', 'closed')).not.toThrow();
    expect(() => assertStatementTransition('closed', 'due')).not.toThrow();
    expect(() => assertStatementTransition('closed', 'paid')).not.toThrow();
    expect(() => assertStatementTransition('due', 'paid')).not.toThrow();
  });

  it('非法路徑拒絕', () => {
    expect(() => assertStatementTransition('open', 'paid')).toThrow();
    expect(() => assertStatementTransition('paid', 'open')).toThrow();
    expect(() => assertStatementTransition('due', 'closed')).toThrow();
  });
});

describe('預計交易狀態機：scheduled → matched → confirmed | missed | skipped', () => {
  it('合法路徑（含 M1 手動確認 scheduled→confirmed）', () => {
    expect(() => assertExpectedTransition('scheduled', 'matched')).not.toThrow();
    expect(() => assertExpectedTransition('scheduled', 'confirmed')).not.toThrow();
    expect(() => assertExpectedTransition('scheduled', 'missed')).not.toThrow();
    expect(() => assertExpectedTransition('scheduled', 'skipped')).not.toThrow();
    expect(() => assertExpectedTransition('matched', 'confirmed')).not.toThrow();
    expect(() => assertExpectedTransition('missed', 'confirmed')).not.toThrow();
  });

  it('非法路徑拒絕', () => {
    expect(() => assertExpectedTransition('confirmed', 'scheduled')).toThrow();
    expect(() => assertExpectedTransition('skipped', 'confirmed')).toThrow();
    expect(() => assertExpectedTransition('matched', 'missed')).toThrow();
  });
});
