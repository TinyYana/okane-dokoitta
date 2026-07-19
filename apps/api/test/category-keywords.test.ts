import { describe, expect, it } from 'vitest';
import { categorizeByKeyword } from '../src/category-keywords.js';

describe('category keyword rules', () => {
  it('matches literal SUB/SUBR/SUBSCRIPTION markers to 訂閱', () => {
    expect(categorizeByKeyword('GOOGLE *SUB')).toBe('訂閱');
    expect(categorizeByKeyword('APPLE.COM/BILL SUBR')).toBe('訂閱');
    expect(categorizeByKeyword('MERCHANT SUBSCRIPTION FEE')).toBe('訂閱');
  });

  it('matches known subscription brands to 訂閱', () => {
    expect(categorizeByKeyword('NETFLIX.COM')).toBe('訂閱');
    expect(categorizeByKeyword('Spotify P0A1B2C3')).toBe('訂閱');
  });

  it('matches game platforms and cinemas to 娛樂', () => {
    expect(categorizeByKeyword('STEAM PURCHASE')).toBe('娛樂');
    expect(categorizeByKeyword('威秀影城 信義店')).toBe('娛樂');
  });

  it('does not false-positive on words merely containing SUB as a substring', () => {
    expect(categorizeByKeyword('SUBWAY TAIPEI')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(categorizeByKeyword('全聯福利中心')).toBeNull();
  });
});
