export type EntitySnapshot = Record<string, unknown>;

export type MutationOperation = 'create' | 'update' | 'delete';

export interface SyncMutation {
  mutationId: string;
  deviceId: string;
  entity: string;
  entityId: string;
  op: MutationOperation;
  baseVersion: number | null;
  payload: Record<string, unknown>;
  clientAt: string;
}

export interface MutationError {
  code: string;
  message: string;
}

export type MutationResponse =
  | { mutationId: string; result: 'applied'; version?: number | null }
  | { mutationId: string; result: 'duplicate'; version?: number | null }
  | {
      mutationId: string;
      result: 'rejected_conflict';
      serverSnapshot: EntitySnapshot;
      error?: MutationError | null;
    }
  | { mutationId: string; result: 'rejected_invalid'; error?: MutationError | null };

export interface Change<TSnapshot extends EntitySnapshot = EntitySnapshot> {
  seq: string;
  entity: string;
  entityId: string;
  version: number;
  snapshot: TSnapshot;
}

export interface ChangeFeed<TSnapshot extends EntitySnapshot = EntitySnapshot> {
  changes: readonly Change<TSnapshot>[];
  nextSince: string;
}

export interface MirrorEntry<TSnapshot extends EntitySnapshot = EntitySnapshot> {
  version: number;
  snapshot: TSnapshot;
}

export type Mirror<TSnapshot extends EntitySnapshot = EntitySnapshot> = ReadonlyMap<string, MirrorEntry<TSnapshot>>;

export interface OutboxItem<TSnapshot extends EntitySnapshot = EntitySnapshot> {
  mutation: SyncMutation;
  localSnapshot: TSnapshot;
}

export interface ConflictItem<TSnapshot extends EntitySnapshot = EntitySnapshot> extends OutboxItem<TSnapshot> {
  serverSnapshot: TSnapshot;
  error?: MutationError | null;
}

export type DraftReason =
  | { kind: 'rejected_invalid'; error?: MutationError | null }
  | { kind: 'blocked_by_invalid'; blockedByMutationId: string };

export interface DraftItem<TSnapshot extends EntitySnapshot = EntitySnapshot> extends OutboxItem<TSnapshot> {
  reason: DraftReason;
}

export interface SyncQueueState<TSnapshot extends EntitySnapshot = EntitySnapshot> {
  outbox: readonly OutboxItem<TSnapshot>[];
  conflicts: readonly ConflictItem<TSnapshot>[];
  drafts: readonly DraftItem<TSnapshot>[];
}
