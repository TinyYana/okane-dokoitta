import type {
  ConflictItem,
  DraftItem,
  EntitySnapshot,
  MutationResponse,
  OutboxItem,
  SyncQueueState,
} from './types.js';

export function emptySyncQueue<TSnapshot extends EntitySnapshot = EntitySnapshot>(): SyncQueueState<TSnapshot> {
  return { outbox: [], conflicts: [], drafts: [] };
}

export function enqueueMutation<TSnapshot extends EntitySnapshot>(
  state: SyncQueueState<TSnapshot>,
  item: OutboxItem<TSnapshot>,
): SyncQueueState<TSnapshot> {
  return { ...state, outbox: [...state.outbox, item] };
}

export function nextMutation<TSnapshot extends EntitySnapshot>(
  state: SyncQueueState<TSnapshot>,
): OutboxItem<TSnapshot> | undefined {
  return state.outbox[0];
}

export function applyMutationResponse<TSnapshot extends EntitySnapshot>(
  state: SyncQueueState<TSnapshot>,
  response: MutationResponse,
): SyncQueueState<TSnapshot> {
  const index = state.outbox.findIndex((item) => item.mutation.mutationId === response.mutationId);
  if (index === -1) return state;
  if (index !== 0) throw new Error(`Out-of-order mutation response: ${response.mutationId}`);

  const item = state.outbox[0];
  if (!item) return state;

  if (response.result === 'applied' || response.result === 'duplicate') {
    return { ...state, outbox: state.outbox.slice(1) };
  }

  if (response.result === 'rejected_conflict') {
    const conflict: ConflictItem<TSnapshot> = {
      ...item,
      serverSnapshot: response.serverSnapshot as TSnapshot,
      ...(response.error === undefined ? {} : { error: response.error }),
    };
    return { ...state, outbox: state.outbox.slice(1), conflicts: [...state.conflicts, conflict] };
  }

  const sameEntity = (candidate: OutboxItem<TSnapshot>) =>
    candidate.mutation.entity === item.mutation.entity && candidate.mutation.entityId === item.mutation.entityId;
  const rejected: DraftItem<TSnapshot> = {
    ...item,
    reason: {
      kind: 'rejected_invalid',
      ...(response.error === undefined ? {} : { error: response.error }),
    },
  };
  const dependents: DraftItem<TSnapshot>[] = state.outbox.slice(1).filter(sameEntity).map((candidate) => ({
    ...candidate,
    reason: { kind: 'blocked_by_invalid', blockedByMutationId: item.mutation.mutationId },
  }));

  return {
    ...state,
    outbox: state.outbox.slice(1).filter((candidate) => !sameEntity(candidate)),
    drafts: [...state.drafts, rejected, ...dependents],
  };
}
