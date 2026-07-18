import { normalizeMerchant } from '@okane-dokoitta/audit-engine';

interface HistoryRow {
  type: string;
  merchantRaw: string | null;
  categoryAccountId: string | null;
}

export function suggestCategoryFromHistory(
  rows: readonly HistoryRow[],
  merchantRaw: string,
  type: 'expense' | 'income',
): { categoryAccountId: string; matches: number; confidence: number } | null {
  const merchant = normalizeMerchant(merchantRaw);
  if (!merchant) return null;

  const counts = new Map<string, number>();
  let total = 0;
  let bestId = '';
  let bestCount = 0;

  for (const row of rows) {
    if (row.type !== type || !row.categoryAccountId || normalizeMerchant(row.merchantRaw ?? '') !== merchant) continue;
    const count = (counts.get(row.categoryAccountId) ?? 0) + 1;
    counts.set(row.categoryAccountId, count);
    total += 1;
    if (count > bestCount) {
      bestId = row.categoryAccountId;
      bestCount = count;
    }
  }

  return bestId ? { categoryAccountId: bestId, matches: bestCount, confidence: bestCount / total } : null;
}
