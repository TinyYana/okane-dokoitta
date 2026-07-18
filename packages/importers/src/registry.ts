import { genericCsvImporter } from './generic-csv/index.js';
import { genericTextImporter } from './generic-text/index.js';
import { unionBankCreditCardImporter } from './union-bank-credit-card/index.js';
import type { Importer, ImportInput } from './types.js';

export const importers: readonly Importer[] = [unionBankCreditCardImporter, genericCsvImporter, genericTextImporter];

export const blockedImporters = [
  { id: 'moze-export', reason: 'OPEN_QUESTIONS Q8：缺少去識別化 MOZE 匯出樣本' },
  { id: 'cathay-credit-card', reason: 'OPEN_QUESTIONS Q9：缺少去識別化國泰帳單樣本' },
  { id: 'line-bank', reason: 'OPEN_QUESTIONS Q9：缺少去識別化 LINE Bank 帳單樣本' },
] as const;

export function detectImporters(input: ImportInput): { importer: Importer; confidence: number }[] {
  return importers
    .map((importer) => ({ importer, confidence: importer.detect(input) }))
    .filter(({ confidence }) => confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);
}

export function importerById(id: string): Importer | undefined {
  return importers.find((importer) => importer.id === id);
}
