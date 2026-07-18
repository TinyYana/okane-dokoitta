import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decryptBackupFile, encryptBackupFile } from './backup-crypto.mjs';

test('encrypted backup round-trip and wrong-key rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'okane-dokoitta-backup-test-'));
  const source = join(directory, 'source.tar');
  const encrypted = join(directory, 'backup.odkbak');
  const restored = join(directory, 'restored.tar');
  try {
    const content = Buffer.from('private-ledger\0'.repeat(20_000));
    await writeFile(source, content);
    const output = await open(encrypted, 'wx');
    await output.close();
    await encryptBackupFile(source, encrypted, 'test-key-at-least-32-characters-long');
    assert.equal((await readFile(encrypted)).includes(Buffer.from('private-ledger')), false);
    await decryptBackupFile(encrypted, restored, 'test-key-at-least-32-characters-long');
    assert.deepEqual(await readFile(restored), content);
    await assert.rejects(() => decryptBackupFile(encrypted, join(directory, 'wrong.tar'), 'different-key-at-least-32-characters'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
