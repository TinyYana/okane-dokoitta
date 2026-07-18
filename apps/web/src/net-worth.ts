import type { NetWorthSourceJson } from './store.js';

export interface NetWorthBubbleSource extends NetWorthSourceJson {
  contributionMinor: string;
  deduction: boolean;
  others: boolean;
}

/** 每個來源對淨資產的實際貢獻；負債與資產帳戶負餘額都必須是扣除項。 */
export function netWorthContribution(source: NetWorthSourceJson): bigint {
  const amount = BigInt(source.amountMinor);
  return source.kind === 'liability' ? -abs(amount) : amount;
}

export function netWorthEquation(sources: NetWorthSourceJson[]): { assetsMinor: bigint; deductionsMinor: bigint } {
  let assetsMinor = 0n;
  let deductionsMinor = 0n;
  for (const source of sources) {
    const contribution = netWorthContribution(source);
    if (contribution >= 0n) assetsMinor += contribution;
    else deductionsMinor += -contribution;
  }
  return { assetsMinor, deductionsMinor };
}

export function netWorthBubbleSources(sources: NetWorthSourceJson[], maxShown: number): NetWorthBubbleSource[] {
  const sorted = sources
    .map((source) => {
      const contribution = netWorthContribution(source);
      return { ...source, contributionMinor: contribution.toString(), deduction: contribution < 0n, others: false };
    })
    .filter((source) => BigInt(source.contributionMinor) !== 0n)
    .sort((left, right) => abs(BigInt(left.contributionMinor)) > abs(BigInt(right.contributionMinor)) ? -1 : 1);
  const shown = sorted.slice(0, maxShown);
  const rest = sorted.slice(maxShown);
  if (rest.length > 0) {
    const contribution = rest.reduce((sum, source) => sum + BigInt(source.contributionMinor), 0n);
    shown.push({
      accountId: 'odk-others',
      name: `其他 ${rest.length} 項（淨額）`,
      institution: null,
      kind: contribution < 0n ? 'liability' : 'cash',
      amountMinor: abs(contribution).toString(),
      contributionMinor: contribution.toString(),
      deduction: contribution < 0n,
      others: true,
    });
  }
  return shown;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
