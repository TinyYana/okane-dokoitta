import { listExpiredImportFiles, markImportFilePurgedBySystem, type Db } from '@okane-dokoitta/database';
import type { ApiEnv } from './env.js';
import { removeStoredImport } from './file-store.js';

const INTERVAL_MS = 6 * 60 * 60_000;

export function startRetentionPurge(db: Db, env: ApiEnv): () => void {
  const run = () => void purgeExpiredImports(db, env).catch((error: unknown) => {
    console.error(`[retention] purge failed: ${error instanceof Error ? error.name : 'UnknownError'}`);
  });
  run();
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export async function purgeExpiredImports(db: Db, env: ApiEnv, now = new Date()): Promise<number> {
  const files = await listExpiredImportFiles(db, now.toISOString().slice(0, 10));
  let purged = 0;
  for (const file of files) {
    await removeStoredImport(env.dataDir, file.storagePath, env.importBucket);
    await markImportFilePurgedBySystem(db, file.userId, file.id);
    purged++;
  }
  return purged;
}
