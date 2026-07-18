import {
  applyChangeFeed,
  applyMutationResponse,
  emptySyncQueue,
  enqueueMutation,
  entityKey,
  type ChangeFeed,
  type ConflictItem,
  type DraftItem,
  type EntitySnapshot,
  type MutationResponse,
  type OutboxItem,
  type SyncMutation,
  type SyncQueueState,
} from '@okane-dokoitta/sync';

const DB_VERSION = 1;
const LEGACY_DB_NAME = 'okane-dokoitta';
let activeDbName: string | null = null;

export async function setOfflineUser(userId: string): Promise<void> {
  activeDbName = `${LEGACY_DB_NAME}:${userId}`;
  if (localStorage.getItem('odk-offline-user-partitioned') !== '1') {
    if (await deleteDatabase(LEGACY_DB_NAME)) localStorage.setItem('odk-offline-user-partitioned', '1');
  }
}

export function clearOfflineUser(): void {
  activeDbName = null;
}

function deleteDatabase(name: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve(false);
  });
}

interface CacheRecord { key: string; value: unknown; updatedAt: string }
interface QueueRecord { id: string; item: OutboxItem; queuedAt: string }
interface ItemRecord { id: string; item: unknown }
interface MirrorRecord { key: string; version: number; snapshot: EntitySnapshot }
interface MetaRecord { key: string; value: string }

function openDb(): Promise<IDBDatabase> {
  if (!activeDbName) return Promise.reject(new Error('offline user context is not configured'));
  const dbName = activeDbName;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['cache', 'outbox', 'conflicts', 'drafts', 'mirror', 'meta']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: name === 'cache' || name === 'mirror' || name === 'meta' ? 'key' : 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function cacheResponse(path: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('cache', 'readwrite');
  tx.objectStore('cache').put({ key: path, value, updatedAt: new Date().toISOString() } satisfies CacheRecord);
  await done(tx);
}

export async function cachedResponse<T>(path: string): Promise<T | null> {
  const db = await openDb();
  const tx = db.transaction('cache', 'readonly');
  const row = await req(tx.objectStore('cache').get(path)) as CacheRecord | undefined;
  return (row?.value as T | undefined) ?? null;
}

export async function queueMutation(mutation: SyncMutation): Promise<void> {
  const localSnapshot = await optimisticSnapshot(mutation);
  const item: OutboxItem = { mutation, localSnapshot };
  const state = enqueueMutation(await readQueue(), item);
  await writeQueue(state);
  await applyOptimisticCache(mutation);
}

export async function firstQueuedMutation(): Promise<SyncMutation | null> {
  return (await readQueue()).outbox[0]?.mutation ?? null;
}

export async function handleMutationResponse(response: MutationResponse): Promise<void> {
  const state = applyMutationResponse(await readQueue(), response);
  await writeQueue(state);
}

export async function applyServerFeed(feed: ChangeFeed): Promise<void> {
  const db = await openDb();
  const readTx = db.transaction(['mirror', 'meta'], 'readonly');
  const rows = await req(readTx.objectStore('mirror').getAll()) as MirrorRecord[];
  const mirror = new Map(rows.map((row) => [row.key, { version: row.version, snapshot: row.snapshot }]));
  const applied = applyChangeFeed(mirror, feed);
  const writeTx = db.transaction(['mirror', 'meta'], 'readwrite');
  const store = writeTx.objectStore('mirror');
  for (const [key, value] of applied.mirror) store.put({ key, ...value } satisfies MirrorRecord);
  writeTx.objectStore('meta').put({ key: 'cursor', value: String(applied.since) } satisfies MetaRecord);
  await done(writeTx);
}

export async function syncCursor(): Promise<string> {
  const db = await openDb();
  const tx = db.transaction('meta', 'readonly');
  const row = await req(tx.objectStore('meta').get('cursor')) as MetaRecord | undefined;
  return row?.value ?? '0';
}

export async function queueCounts(): Promise<{ queued: number; conflicts: number; drafts: number }> {
  const state = await readQueue();
  return { queued: state.outbox.length, conflicts: state.conflicts.length, drafts: state.drafts.length };
}

export async function listSyncIssues(): Promise<{ conflicts: readonly ConflictItem[]; drafts: readonly DraftItem[] }> {
  const state = await readQueue();
  return { conflicts: state.conflicts, drafts: state.drafts };
}

export async function resolveConflict(
  mutationId: string,
  choice: 'server' | 'local',
  replacementMutationId?: string,
): Promise<void> {
  const state = await readQueue();
  const conflict = state.conflicts.find((item) => item.mutation.mutationId === mutationId);
  if (!conflict) return;
  let next: SyncQueueState = { ...state, conflicts: state.conflicts.filter((item) => item.mutation.mutationId !== mutationId) };
  if (choice === 'local') {
    if (!replacementMutationId) throw new Error('replacement mutation id required');
    const serverVersion = conflict.serverSnapshot['version'];
    next = enqueueMutation(next, {
      ...conflict,
      mutation: {
        ...conflict.mutation,
        mutationId: replacementMutationId,
        baseVersion: typeof serverVersion === 'number' ? serverVersion : conflict.mutation.baseVersion,
        clientAt: new Date().toISOString(),
      },
    });
  } else {
    await putMirror(conflict.mutation.entity, conflict.mutation.entityId, conflict.serverSnapshot);
  }
  await writeQueue(next);
}

export async function discardDraft(mutationId: string): Promise<void> {
  const state = await readQueue();
  await writeQueue({ ...state, drafts: state.drafts.filter((item) => item.mutation.mutationId !== mutationId) });
}

async function readQueue() {
  const db = await openDb();
  const tx = db.transaction(['outbox', 'conflicts', 'drafts'], 'readonly');
  const [outboxRows, conflictRows, draftRows] = await Promise.all([
    req(tx.objectStore('outbox').getAll()) as Promise<QueueRecord[]>,
    req(tx.objectStore('conflicts').getAll()) as Promise<ItemRecord[]>,
    req(tx.objectStore('drafts').getAll()) as Promise<ItemRecord[]>,
  ]);
  let state = emptySyncQueue();
  for (const row of outboxRows.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))) state = enqueueMutation(state, row.item);
  return { ...state, conflicts: conflictRows.map((row) => row.item) as typeof state.conflicts, drafts: draftRows.map((row) => row.item) as typeof state.drafts };
}

async function writeQueue(state: Awaited<ReturnType<typeof readQueue>>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['outbox', 'conflicts', 'drafts'], 'readwrite');
  for (const name of ['outbox', 'conflicts', 'drafts']) tx.objectStore(name).clear();
  for (const item of state.outbox) {
    tx.objectStore('outbox').put({
      id: item.mutation.mutationId,
      item,
      queuedAt: item.mutation.clientAt,
    } satisfies QueueRecord);
  }
  for (const item of state.conflicts) tx.objectStore('conflicts').put({ id: item.mutation.mutationId, item } satisfies ItemRecord);
  for (const item of state.drafts) tx.objectStore('drafts').put({ id: item.mutation.mutationId, item } satisfies ItemRecord);
  await done(tx);
}

async function optimisticSnapshot(mutation: SyncMutation): Promise<EntitySnapshot> {
  const db = await openDb();
  const tx = db.transaction('mirror', 'readonly');
  const current = await req(tx.objectStore('mirror').get(entityKey(mutation.entity, mutation.entityId))) as MirrorRecord | undefined;
  return { ...(current?.snapshot ?? {}), ...mutation.payload, id: mutation.entityId, version: (mutation.baseVersion ?? 0) + 1 };
}

async function putMirror(entity: string, entityId: string, snapshot: EntitySnapshot): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('mirror', 'readwrite');
  tx.objectStore('mirror').put({
    key: entityKey(entity, entityId),
    version: typeof snapshot['version'] === 'number' ? snapshot['version'] : 0,
    snapshot,
  } satisfies MirrorRecord);
  await done(tx);
}

async function applyOptimisticCache(mutation: SyncMutation): Promise<void> {
  const db = await openDb();
  const cacheRowsTx = db.transaction('cache', 'readonly');
  const rows = await req(cacheRowsTx.objectStore('cache').getAll()) as CacheRecord[];
  const tx = db.transaction(['cache', 'mirror'], 'readwrite');
  const mirror = { ...mutation.payload, id: mutation.entityId, version: (mutation.baseVersion ?? 0) + 1, _sync: 'queued' };
  tx.objectStore('mirror').put({ key: entityKey(mutation.entity, mutation.entityId), version: mirror.version, snapshot: mirror } satisfies MirrorRecord);
  const cache = tx.objectStore('cache');
  for (const row of rows) {
    if (mutation.entity === 'transactions' && row.key.startsWith('/api/transactions?')) {
      const value = row.value as { transactions?: EntitySnapshot[] };
      if (!Array.isArray(value.transactions)) continue;
      const current = value.transactions.find((item) => item['id'] === mutation.entityId);
      const next = mutation.op === 'delete'
        ? value.transactions.filter((item) => item['id'] !== mutation.entityId)
        : mutation.op === 'create'
          ? [{ ...mirror }, ...value.transactions]
          : value.transactions.map((item) => item['id'] === mutation.entityId ? { ...item, ...mirror } : item);
      cache.put({ ...row, value: { ...value, transactions: next } });
      if (current) tx.objectStore('mirror').put({ key: entityKey(mutation.entity, mutation.entityId), version: mirror.version, snapshot: { ...current, ...mirror } });
    }
  }
  await done(tx);
}
