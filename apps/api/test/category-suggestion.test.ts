import { describe, expect, it } from 'vitest';
import { suggestCategoryFromHistory } from '../src/category-suggestion.js';

describe('category suggestion', () => {
  it('uses the most frequent exact normalized merchant category and keeps ties recent-first', () => {
    const rows = [
      { type: 'expense', merchantRaw: '全聯 福利中心', categoryAccountId: 'groceries' },
      { type: 'expense', merchantRaw: '全聯福利中心', categoryAccountId: 'daily' },
      { type: 'expense', merchantRaw: '全聯福利中心', categoryAccountId: 'groceries' },
      { type: 'income', merchantRaw: '全聯福利中心', categoryAccountId: 'income' },
    ];

    expect(suggestCategoryFromHistory(rows, ' 全聯福利中心 ', 'expense')).toEqual({
      categoryAccountId: 'groceries',
      matches: 2,
      confidence: 2 / 3,
    });
    expect(suggestCategoryFromHistory(rows, '別家商店', 'expense')).toBeNull();
  });
});
