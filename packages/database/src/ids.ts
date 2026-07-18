import { v7 } from 'uuid';

/**
 * Server 端產生的 UUIDv7：只用於「非 client 建立」的實體
 * （journal entries/lines、audit logs、server 展開的 expected transactions、auth 資料）。
 * Client 建立的實體（accounts、transactions、rules…）的 id 一律由 client 產生（AGENTS §5）。
 */
export function newId(): string {
  return v7();
}
