import { describe, expect, it } from 'vitest';
import {
  applyChangeFeed,
  applyMutationResponse,
  emptySyncQueue,
  enqueueMutation,
  entityKey,
  type MirrorEntry,
  type MutationOperation,
  type OutboxItem,
} from '../src/index.js';

function item(id: string, entityId: string, op: MutationOperation): OutboxItem {
  return {
    mutation: {
      mutationId: id,
      deviceId: id,
      entity: 'transactions',
      entityId,
      op,
      baseVersion: op === 'create' ? null : 1,
      payload: {},
      clientAt: '2026-07-17T00:00:00.000Z',
    },
    localSnapshot: { id: entityId, op },
  };
}

describe('SYNC_DESIGN delete/edit conflict matrix', () => {
  it.each([
    ['update', 'update'],
    ['delete', 'update'],
    ['update', 'delete'],
  ] as const)('%s then %s: later write becomes an explicit conflict', (_first: MutationOperation, second: MutationOperation) => {
    const state = enqueueMutation(emptySyncQueue(), item('later', 'same', second));
    const next = applyMutationResponse(state, {
      mutationId: 'later',
      result: 'rejected_conflict',
      serverSnapshot: { id: 'same', version: 2 },
    });
    expect(next.conflicts).toHaveLength(1);
    expect(next.conflicts[0]?.mutation.op).toBe(second);
  });

  it('delete then delete: second delete is duplicate success', () => {
    const state = enqueueMutation(emptySyncQueue(), item('second-delete', 'same', 'delete'));
    const next = applyMutationResponse(state, { mutationId: 'second-delete', result: 'duplicate', version: 2 });
    expect(next.outbox).toEqual([]);
    expect(next.conflicts).toEqual([]);
  });

  it('create then create with different IDs: both remain independent FIFO writes', () => {
    let state = enqueueMutation(emptySyncQueue(), item('create-a', 'a', 'create'));
    state = enqueueMutation(state, item('create-b', 'b', 'create'));
    state = applyMutationResponse(state, { mutationId: 'create-a', result: 'applied', version: 1 });
    state = applyMutationResponse(state, { mutationId: 'create-b', result: 'applied', version: 1 });
    expect(state.outbox).toEqual([]);
    expect(state.conflicts).toEqual([]);
  });
});

describe('change feed', () => {
  it('replaces an optimistic local mirror entry with the server snapshot', () => {
    const key = entityKey('transactions', 'txn');
    const mirror = new Map<string, MirrorEntry>([
      [key, { version: 9, snapshot: { amountMinor: '999', optimistic: true } }],
    ]);
    const applied = applyChangeFeed(mirror, {
      changes: [{ seq: '12', entity: 'transactions', entityId: 'txn', version: 2, snapshot: { amountMinor: '200' } }],
      nextSince: '12',
    });

    expect(applied.since).toBe('12');
    expect(applied.mirror.get(key)).toEqual({ version: 2, snapshot: { amountMinor: '200' } });
    expect(mirror.get(key)).toEqual({ version: 9, snapshot: { amountMinor: '999', optimistic: true } });
  });
});
