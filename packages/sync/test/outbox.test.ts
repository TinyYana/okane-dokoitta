import { describe, expect, it } from 'vitest';
import {
  applyMutationResponse,
  emptySyncQueue,
  enqueueMutation,
  nextMutation,
  type MutationOperation,
  type OutboxItem,
} from '../src/index.js';

function item(id: string, entityId = id, op: MutationOperation = 'update'): OutboxItem {
  return {
    mutation: {
      mutationId: id,
      deviceId: 'device-a',
      entity: 'transactions',
      entityId,
      op,
      baseVersion: op === 'create' ? null : 1,
      payload: {},
      clientAt: '2026-07-17T00:00:00.000Z',
    },
    localSnapshot: { id: entityId, local: id, deletedAt: op === 'delete' ? '2026-07-17T00:00:00.000Z' : null },
  };
}

describe('outbox FIFO transitions', () => {
  it('applied and duplicate remove the head and repeated responses are idempotent', () => {
    let state = enqueueMutation(enqueueMutation(emptySyncQueue(), item('a')), item('b'));

    state = applyMutationResponse(state, { mutationId: 'a', result: 'applied', version: 2 });
    expect(nextMutation(state)?.mutation.mutationId).toBe('b');
    expect(applyMutationResponse(state, { mutationId: 'a', result: 'applied', version: 2 })).toBe(state);

    state = applyMutationResponse(state, { mutationId: 'b', result: 'duplicate', version: 2 });
    expect(state.outbox).toEqual([]);
    expect(applyMutationResponse(state, { mutationId: 'b', result: 'duplicate', version: 2 })).toBe(state);
  });

  it('rejects a response for a queued item that is not the FIFO head', () => {
    const state = enqueueMutation(enqueueMutation(emptySyncQueue(), item('a')), item('b'));
    expect(() => applyMutationResponse(state, { mutationId: 'b', result: 'applied', version: 2 })).toThrow(
      'Out-of-order mutation response',
    );
  });

  it('moves a conflict with both local and server snapshots', () => {
    const state = enqueueMutation(emptySyncQueue(), item('a'));
    const next = applyMutationResponse(state, {
      mutationId: 'a',
      result: 'rejected_conflict',
      serverSnapshot: { id: 'a', amountMinor: '200' },
    });

    expect(next.outbox).toEqual([]);
    expect(next.conflicts[0]).toMatchObject({
      localSnapshot: { id: 'a', local: 'a' },
      serverSnapshot: { id: 'a', amountMinor: '200' },
    });
    expect(applyMutationResponse(next, {
      mutationId: 'a',
      result: 'rejected_conflict',
      serverSnapshot: { id: 'a', amountMinor: '200' },
    })).toBe(next);
  });

  it('returns invalid mutation and same-record dependents to drafts without blocking other records', () => {
    let state = emptySyncQueue();
    state = enqueueMutation(state, item('bad-update', 'same'));
    state = enqueueMutation(state, item('other', 'other'));
    state = enqueueMutation(state, item('dependent-delete', 'same', 'delete'));

    const next = applyMutationResponse(state, {
      mutationId: 'bad-update',
      result: 'rejected_invalid',
      error: { code: 'INVALID', message: 'invalid payload' },
    });

    expect(next.outbox.map((queued) => queued.mutation.mutationId)).toEqual(['other']);
    expect(next.drafts.map((draft) => [draft.mutation.mutationId, draft.reason.kind])).toEqual([
      ['bad-update', 'rejected_invalid'],
      ['dependent-delete', 'blocked_by_invalid'],
    ]);
    expect(applyMutationResponse(next, {
      mutationId: 'bad-update',
      result: 'rejected_invalid',
      error: { code: 'INVALID', message: 'invalid payload' },
    })).toBe(next);
  });
});
