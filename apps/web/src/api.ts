import type { MutationEntity } from '@okane-dokoitta/schemas';
import type { MutationResponse, SyncMutation } from '@okane-dokoitta/sync';
import { v7 as uuidv7 } from 'uuid';
import {
  applyServerFeed,
  cacheResponse,
  cachedResponse,
  firstQueuedMutation,
  handleMutationResponse,
  queueCounts,
  queueMutation,
  clearOfflineUser,
  setOfflineUser,
  syncCursor,
} from './offline.js';

/** 同源 cookie session + CSRF；離線寫入先落 IndexedDB outbox。 */

let csrfToken = '';
let syncChain: Promise<void> = Promise.resolve();
let syncStarted = false;
let deviceRegistered = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let activeUserId: string | null = null;
const outcomes = new Map<string, MutationResponse>();
const RETRY_MS = 15_000;

export interface SyncStatus {
  phase: 'online' | 'syncing' | 'offline';
  queued: number;
  conflicts: number;
  drafts: number;
}

let currentSyncStatus: SyncStatus = { phase: navigator.onLine ? 'online' : 'offline', queued: 0, conflicts: 0, drafts: 0 };
const syncListeners = new Set<(status: SyncStatus) => void>();

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export async function configureUserContext(userId: string): Promise<void> {
  activeUserId = userId;
  deviceRegistered = false;
  await setOfflineUser(userId);
}

export function clearUserContext(): void {
  activeUserId = null;
  deviceRegistered = false;
  outcomes.clear();
  clearOfflineUser();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    const value = await networkRequest<T>(method, path, body);
    if (method === 'GET' && cacheable(path)) await cacheResponse(path, value);
    return value;
  } catch (error) {
    if (method === 'GET' && cacheable(path) && isNetworkFailure(error)) {
      const cached = await cachedResponse<T>(path);
      if (cached !== null) return cached;
    }
    throw error;
  }
}

async function networkRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['x-odk-csrf'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError('NETWORK_UNAVAILABLE', '目前無法連線，資料會保留在這台裝置', 0);
  }
  const json = (await res.json().catch(() => null)) as
    | (T & { error?: { code: string; message: string } })
    | null;
  if (!res.ok) {
    const err = json?.error;
    throw new ApiError(err?.code ?? 'HTTP_ERROR', err?.message ?? `HTTP ${res.status}`, res.status);
  }
  return json as T;
}

function cacheable(path: string): boolean {
  return path.startsWith('/api/accounts') || path.startsWith('/api/transactions') || path.startsWith('/api/recurring');
}

function isNetworkFailure(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'NETWORK_UNAVAILABLE';
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
};

export type MutationOutcomeJson = MutationResponse | { mutationId: string; result: 'queued' };

export async function mutate(
  entity: MutationEntity,
  op: 'create' | 'update' | 'delete',
  entityId: string,
  payload: Record<string, unknown>,
  baseVersion: number | null = null,
): Promise<MutationOutcomeJson> {
  const mutation: SyncMutation = {
    mutationId: uuidv7(),
    deviceId: currentDeviceId(),
    entity,
    entityId,
    op,
    baseVersion,
    payload,
    clientAt: new Date().toISOString(),
  };
  await queueMutation(mutation);
  // iOS PWA 的 navigator.onLine 常誤報離線——一律直接嘗試送出，失敗才算離線
  await syncNow();
  const outcome = outcomes.get(mutation.mutationId);
  outcomes.delete(mutation.mutationId);
  if (!outcome) return { mutationId: mutation.mutationId, result: 'queued' };
  if (outcome.result === 'rejected_invalid') {
    throw new ApiError(outcome.error?.code ?? 'INVALID', outcome.error?.message ?? '寫入被拒絕', 422);
  }
  if (outcome.result === 'rejected_conflict') {
    throw new ApiError('VERSION_CONFLICT', '資料已在其他地方被更新，請到同步狀態處理差異', 409);
  }
  return outcome;
}

export async function startSync(): Promise<void> {
  if (!syncStarted) {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    syncStarted = true;
  }
  await syncNow();
}

export function stopSync(): void {
  if (!syncStarted) return;
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', onOffline);
  document.removeEventListener('visibilitychange', onVisible);
  if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  syncStarted = false;
}

export function subscribeSyncStatus(listener: (status: SyncStatus) => void): () => void {
  syncListeners.add(listener);
  listener(currentSyncStatus);
  return () => syncListeners.delete(listener);
}

export function getSyncStatus(): SyncStatus {
  return currentSyncStatus;
}

// 序列化而非搭便車：mutate 排進 outbox 後呼叫 syncNow，保證有一輪「在它之後開始」的
// runSync 會處理到它——舊版撞到進行中的同步就直接回傳，mutation 卡在 outbox 沒人送。
export function syncNow(): Promise<void> {
  const run = syncChain.then(runSync, runSync);
  syncChain = run.catch(() => {});
  return run;
}

async function runSync(): Promise<void> {
  await refreshSyncStatus('syncing');
  try {
    await registerCurrentDevice();
    for (let mutation = await firstQueuedMutation(); mutation; mutation = await firstQueuedMutation()) {
      const outcome = await mutationRequest(mutation);
      outcomes.set(mutation.mutationId, outcome);
      await handleMutationResponse(outcome);
    }
    const cursor = await syncCursor();
    const feed = await networkRequest<Parameters<typeof applyServerFeed>[0]>('GET', `/api/sync/changes?since=${encodeURIComponent(cursor)}`);
    await applyServerFeed(feed);
    await refreshSyncStatus('online');
  } catch (error) {
    await refreshSyncStatus(isNetworkFailure(error) ? 'offline' : 'online');
    if (currentSyncStatus.queued > 0) scheduleRetry();
    if (!isNetworkFailure(error)) throw error;
  }
}

/** 離線/失敗後的補送：15 秒後再試，成功那輪會清掉 outbox 就不再排 */
function scheduleRetry(): void {
  if (retryTimer !== null || !syncStarted) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void syncNow().catch(() => {});
  }, RETRY_MS);
}

async function mutationRequest(mutation: SyncMutation): Promise<MutationResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrfToken) headers['x-odk-csrf'] = csrfToken;
  let response: Response;
  try {
    response = await fetch('/api/mutations', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(mutation),
    });
  } catch {
    throw new ApiError('NETWORK_UNAVAILABLE', '目前無法連線，資料會保留在這台裝置', 0);
  }
  const json = await response.json().catch(() => null) as
    | MutationResponse
    | { error?: { code?: string; message?: string } }
    | null;
  if (json && 'result' in json) return json;
  const error = json?.error;
  throw new ApiError(error?.code ?? 'HTTP_ERROR', error?.message ?? `HTTP ${response.status}`, response.status);
}

async function registerCurrentDevice(): Promise<void> {
  if (deviceRegistered) return; // 每個 session 註冊一次就好，省每輪同步一趟 round trip
  await networkRequest('POST', '/api/sync/devices/register', {
    id: currentDeviceId(),
    name: deviceName(),
    platform: navigator.userAgent.slice(0, 80),
  });
  deviceRegistered = true;
}

function onOnline(): void {
  void syncNow().catch((error: unknown) => {
    console.warn('背景同步失敗', error instanceof ApiError ? error.code : 'UNKNOWN');
  });
}

function onOffline(): void {
  void refreshSyncStatus('offline');
}

/** iOS PWA 從背景切回來不會發 online 事件，用 visibilitychange 補一輪同步 */
function onVisible(): void {
  if (document.visibilityState === 'visible') {
    void syncNow().catch((error: unknown) => {
      console.warn('背景同步失敗', error instanceof ApiError ? error.code : 'UNKNOWN');
    });
  }
}

async function refreshSyncStatus(phase: SyncStatus['phase']): Promise<void> {
  currentSyncStatus = { phase, ...(await queueCounts()) };
  for (const listener of syncListeners) listener(currentSyncStatus);
}

function deviceName(): string {
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  return mobile ? '行動裝置' : '瀏覽器';
}

export function newEntityId(): string {
  return uuidv7();
}

export function currentDeviceId(): string {
  if (!activeUserId) throw new Error('user context is not configured');
  const key = `odk-device-id:${activeUserId}`;
  let id = localStorage.getItem(key);
  if (!id || id.startsWith('web-')) {
    id = uuidv7();
    localStorage.setItem(key, id);
  }
  return id;
}
