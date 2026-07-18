import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM 對稱加密，金鑰由 sessionSecret 依用途（domain）字串派生 —— 不同用途金鑰互不相通，
 * 單一 domain 外洩不影響其他 domain（AGENTS §7：secrets 應用層加密儲存）。
 */
export function encryptSecret(appSecret: string, domain: string, plaintext: string): string {
  const key = createHash('sha256').update(`${domain}:${appSecret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(appSecret: string, domain: string, envelope: string): string {
  const [ivText, tagText, ciphertextText] = envelope.split('.');
  if (!ivText || !tagText || !ciphertextText) throw new Error('invalid encrypted secret');
  const key = createHash('sha256').update(`${domain}:${appSecret}`).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
}
