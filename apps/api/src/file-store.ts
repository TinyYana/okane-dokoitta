import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const MAGIC = Buffer.from('ODKFILE1');

export interface ImportBucket {
  put(key: string, value: ArrayBufferView): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export async function storeEncryptedImport(
  dataDir: string,
  userId: string,
  fileId: string,
  plaintext: Uint8Array,
  secret: string,
  bucket: ImportBucket | null = null,
): Promise<string> {
  const storagePath = `${userId}/${fileId}.enc`;
  const iv = randomBytes(12);
  const key = createHash('sha256').update(`import-file:${secret}`).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  if (bucket) {
    await bucket.put(storagePath, envelope);
    return storagePath;
  }
  const target = safeTarget(dataDir, storagePath);
  const temporary = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, envelope, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return storagePath;
}

export async function removeStoredImport(dataDir: string, storagePath: string, bucket: ImportBucket | null = null): Promise<void> {
  if (bucket) return bucket.delete(storagePath);
  await rm(safeTarget(dataDir, storagePath), { force: true });
}

function safeTarget(dataDir: string, storagePath: string): string {
  if (isAbsolute(storagePath)) throw new Error('absolute storage path rejected');
  const root = resolve(dataDir);
  const target = resolve(root, storagePath);
  const pathFromRoot = relative(root, target);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error('storage path escaped data directory');
  }
  return target;
}
