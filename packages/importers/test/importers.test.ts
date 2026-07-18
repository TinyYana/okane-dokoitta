import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  blockedImporters,
  genericCsvImporter,
  genericTextImporter,
  IMPORT_LIMITS,
  importerById,
  detectImporters,
  protectSpreadsheetFormula,
  unionBankCreditCardImporter,
} from '../src/index.js';

function fixture(importer: 'generic-csv' | 'generic-text' | 'union-bank-credit-card', name: string): string {
  return readFileSync(new URL(`../fixtures/${importer}/${name}`, import.meta.url), 'utf8');
}

function normalizedUnion(result: Awaited<ReturnType<typeof unionBankCreditCardImporter.parse>>) {
  return {
    ...result.statement,
    totalMinor: result.statement.totalMinor?.toString(),
    transactions: result.statement.transactions.map(({ metadata: _metadata, ...transaction }) => ({
      ...transaction,
      amountMinor: transaction.amountMinor.toString(),
    })),
  };
}

function normalized(result: Awaited<ReturnType<typeof genericCsvImporter.parse>>) {
  return {
    importerId: result.statement.importerId,
    currency: result.statement.currency,
    transactions: result.statement.transactions.map(({ metadata: _metadata, ...transaction }) => ({
      ...transaction,
      amountMinor: transaction.amountMinor.toString(),
    })),
    ...(result.warnings.length ? { warningLines: result.warnings.map((warning) => warning.line) } : {}),
  };
}

describe('generic-csv', () => {
  it.each(['normal', 'refund-installment'])('matches the %s fixture', async (name) => {
    const result = await genericCsvImporter.parse({ kind: 'csv', text: fixture('generic-csv', `${name}.csv`) });
    expect(normalized(result)).toEqual(JSON.parse(fixture('generic-csv', `${name}.expected.json`)));
  });

  it('supports explicit column mapping without guessing values', async () => {
    const result = await genericCsvImporter.parse({
      kind: 'csv',
      text: 'when,who,value\n2026-07-01,Sample Shop,1',
      columns: { occurredAt: 'when', merchant: 'who', amount: 'value' },
      defaults: { currency: 'TWD' },
    });
    expect(result.statement.transactions[0]?.amountMinor).toBe(1n);
  });
});

describe('generic-text', () => {
  it.each(['normal', 'usd-edge'])('matches the %s fixture', async (name) => {
    const result = await genericTextImporter.parse({ kind: 'text', text: fixture('generic-text', `${name}.txt`) });
    expect(normalized(result)).toEqual(JSON.parse(fixture('generic-text', `${name}.expected.json`)));
  });
});

describe('union-bank-credit-card', () => {
  it.each(['multi-card', 'year-boundary-refund'])('matches the %s fixture', async (name) => {
    const text = fixture('union-bank-credit-card', `${name}.csv`);
    const result = await unionBankCreditCardImporter.parse({ kind: 'csv', text });
    expect(normalizedUnion(result)).toEqual(JSON.parse(fixture('union-bank-credit-card', `${name}.expected.json`)));
    expect(result.warnings.map((warning) => warning.code)).toEqual([]);
    expect(detectImporters({ kind: 'csv', text })[0]?.importer.id).toBe('union-bank-credit-card');
  });

  it('rejects an invalid statement total as a controlled format error', async () => {
    const text = fixture('union-bank-credit-card', 'multi-card.csv').replace('115/07/15,115/08/03,0,0,0,600,600,100', '115/07/15,115/08/03,0,0,0,600,not-a-number,100');
    await expect(unionBankCreditCardImporter.parse({ kind: 'csv', text })).rejects.toMatchObject({ code: 'FORMAT_INVALID' });
  });

  it('rejects transactions that cannot be assigned to a card section', async () => {
    const text = fixture('union-bank-credit-card', 'multi-card.csv').replace(/^,,.*－正卡.*\r?\n/gm, '');
    await expect(unionBankCreditCardImporter.parse({ kind: 'csv', text })).rejects.toMatchObject({ code: 'FORMAT_INVALID' });
  });
});

describe('security and capability boundaries', () => {
  it('protects formula-like fields when exporting CSV', () => {
    expect(protectSpreadsheetFormula('=2+2')).toBe("'=2+2");
    expect(protectSpreadsheetFormula('-100')).toBe("'-100");
    expect(protectSpreadsheetFormula('ordinary')).toBe('ordinary');
  });

  it('rejects input above the parser character limit', async () => {
    await expect(genericTextImporter.parse({ kind: 'text', text: 'x'.repeat(IMPORT_LIMITS.maxCharacters + 1) })).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
  });

  it('rejects oversized CSV cells before normalization', async () => {
    const text = `date,merchant,amount,currency\n2026-07-01,${'x'.repeat(IMPORT_LIMITS.maxCellCharacters + 1)},1,TWD`;
    await expect(genericCsvImporter.parse({ kind: 'csv', text })).rejects.toMatchObject({ code: 'CELL_TOO_LARGE' });
  });

  it('does not register unsupported source-specific importers', () => {
    expect(blockedImporters.map(({ id }) => id)).toEqual(['moze-export', 'cathay-credit-card', 'line-bank']);
    for (const { id } of blockedImporters) expect(importerById(id)).toBeUndefined();
    expect(importerById('union-bank-credit-card')).toBe(unionBankCreditCardImporter);
  });
});
