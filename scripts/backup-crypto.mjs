import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const MAGIC = Buffer.from('ODKBAK01');
const HEADER_BYTES = 8 + 16 + 12 + 16;

export async function encryptBackupFile(input, output, secret) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scrypt(secret, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const header = Buffer.concat([MAGIC, salt, iv, Buffer.alloc(16)]);
  await pipeline(createReadStream(input), cipher, createWriteStream(output, { flags: 'r+', start: HEADER_BYTES }));
  const handle = await open(output, 'r+');
  try {
    await handle.write(header, 0, header.length, 0);
    await handle.write(cipher.getAuthTag(), 0, 16, 8 + 16 + 12);
  } finally {
    await handle.close();
  }
}

export async function decryptBackupFile(input, output, secret) {
  const handle = await open(input, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  try {
    const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0);
    if (bytesRead !== HEADER_BYTES || !header.subarray(0, 8).equals(MAGIC)) throw new Error('invalid okane-dokoitta backup');
  } finally {
    await handle.close();
  }
  const salt = header.subarray(8, 24);
  const iv = header.subarray(24, 36);
  const tag = header.subarray(36, 52);
  const key = await scrypt(secret, salt, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(input, { start: HEADER_BYTES }), decipher, createWriteStream(output));
}
