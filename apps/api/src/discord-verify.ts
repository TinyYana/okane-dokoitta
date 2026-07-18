/** Discord interactions endpoint 簽章驗證（ADR-005）：Ed25519，Web Crypto（Node 與 Workers 皆原生支援）。 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('invalid hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  rawBody: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), 'Ed25519', false, ['verify']);
    const message = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(signatureHex), message);
  } catch {
    return false; // 格式錯誤的 hex/簽章一律視為驗證失敗，不拋錯中斷 request
  }
}
