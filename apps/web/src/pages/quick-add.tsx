import { currencyInfo, parseAmount } from '@okane-dokoitta/domain';
import { Button, Dialog, Field, Segmented, TextInput, useToast } from '@okane-dokoitta/ui';
import gsap from 'gsap';
import { ArrowDownCircle, ArrowLeftRight, ArrowUpCircle, Delete, Eye, EyeOff } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ApiError, api, mutate, newEntityId } from '../api.js';
import { categoryIcon } from '../category-icons.js';
import { netWorthBubbleSources, netWorthEquation } from '../net-worth.js';
import {
  bumpRecent,
  formatAmount,
  isActive,
  isPrivacyMasked,
  sortByRecent,
  togglePrivacyMask,
  useAccounts,
  type AccountJson,
  type ExpectedJson,
  type NetWorthJson,
  type RecurringRuleJson,
} from '../store.js';

type EntryType = 'expense' | 'income' | 'transfer';

/** F1 快速記帳：金額（數字鍵盤先出）→ 帳戶（最近使用排前）→ 分類 → 存。目標 3 次點擊。 */
export function QuickAddPage() {
  const { accounts, loaded, reload } = useAccounts();
  const toast = useToast();
  const [entryType, setEntryType] = useState<EntryType>('expense');
  const [digits, setDigits] = useState('');
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [merchant, setMerchant] = useState('');
  const [suggestion, setSuggestion] = useState<{ categoryAccountId: string; matches: number } | null>(null);
  const [dateStr, setDateStr] = useState(() => todayLocalDate());
  const [busy, setBusy] = useState(false);
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [amountSelected, setAmountSelected] = useState(false);
  const amountRef = useRef<HTMLDivElement>(null);

  const active = accounts.filter(isActive);
  const spendable = sortByRecent(
    active.filter((a) =>
      (a.kind === 'asset' && a.subtype !== 'brokerage_settlement' && a.subtype !== 'investment_asset')
      || a.subtype === 'credit_card',
    ),
    'odk-recent-accounts',
  );
  const transferTargets = active.filter((a) => (a.kind === 'asset' || a.kind === 'liability') && a.subtype !== 'credit_card');
  // 轉帳的轉出方比 spendable 多開放交割戶（賣股後把現金轉出交割戶）；
  // 投資資產帳戶仍排除——那要用「賣出」調整持倉，不能用轉帳繞過。
  const transferSources = active.filter((a) => a.kind === 'asset' && a.subtype !== 'investment_asset');
  const categories = sortByRecent(
    active.filter((a) => a.subtype === (entryType === 'income' ? 'category_income' : 'category_expense')),
    `odk-recent-categories-${entryType}`,
  );

  const sourceList = entryType === 'transfer' ? transferSources : spendable;
  const selectedAccount = active.find((a) => a.id === (entryType === 'income' ? toAccountId : accountId));
  const currency = selectedAccount?.currency ?? 'TWD';
  const exponent = useMemo(() => currencyInfo(currency).exponent, [currency]);

  // 預設帶入最近使用
  useEffect(() => {
    if (!loaded) return;
    if (entryType === 'income') {
      if (!toAccountId && spendable[0]) setToAccountId(spendable[0].id);
    } else if (!accountId && sourceList[0]) {
      setAccountId(sourceList[0].id);
    }
    if (!categoryId && categories[0]) setCategoryId(categories[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, entryType]);

  useLayoutEffect(() => {
    if (!digits) return;
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(amountRef.current, { scale: 0.975, y: 2 }, { scale: 1, y: 0, duration: 0.18, ease: 'back.out(1.2)' });
    });
    return () => media.revert();
  }, [digits]);

  function pressKey(key: string) {
    if (amountSelected) {
      // 全選狀態：Backspace 清空、數字/小數點取代整個金額
      setAmountSelected(false);
      if (key === '⌫') return setDigits('');
      if (key === '.') return setDigits(exponent > 0 ? '0.' : '');
      setDigits('');
    }
    if (key === '⌫') return setDigits((d) => d.slice(0, -1));
    if (key === '.') {
      if (exponent === 0 || digits.includes('.')) return;
      return setDigits((d) => (d === '' ? '0.' : `${d}.`));
    }
    setDigits((d) => {
      const next = d + key;
      const [, fraction] = next.split('.');
      if (fraction && fraction.length > exponent) return d;
      if (next.replace('.', '').length > 12) return d;
      return next.replace(/^0+(?=\d)/, '');
    });
  }

  // 實體鍵盤（桌機）：數字直接輸入、Backspace/Delete 刪除、Ctrl+A 全選、Enter 儲存。
  // 焦點在輸入框（商家、日期、對話框）時不攔截。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (showNewCategory) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        if (!digits) return;
        e.preventDefault();
        setAmountSelected(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^\d$/.test(e.key) || e.key === '.') {
        e.preventDefault();
        pressKey(e.key);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        pressKey('⌫');
      } else if (e.key === 'Escape') {
        setAmountSelected(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function save() {
    if (!digits || digits === '0.' || Number(digits.replace('.', '')) === 0) return toast('先輸入金額', 'error');
    setBusy(true);
    try {
      const amountMinor = parseAmount(digits, currency).toString();
      const occurredAt = combineDateWithNow(dateStr);
      if (entryType === 'transfer') {
        if (!accountId || !toAccountId) return toast('選擇轉出與轉入帳戶', 'error');
        await mutate('transactions', 'create', newEntityId(), {
          type: 'transfer',
          amountMinor,
          currency,
          fromAccountId: accountId,
          toAccountId,
          note: merchant || null,
          occurredAt,
          source: 'manual',
        });
      } else if (entryType === 'income') {
        if (!toAccountId || !categoryId) return toast('選擇帳戶與分類', 'error');
        await mutate('transactions', 'create', newEntityId(), {
          type: 'income',
          amountMinor,
          currency,
          toAccountId,
          categoryAccountId: categoryId,
          merchantRaw: merchant || null,
          occurredAt,
          source: 'manual',
        });
        bumpRecent('odk-recent-categories-income', categoryId);
      } else {
        if (!accountId || !categoryId) return toast('選擇帳戶與分類', 'error');
        await mutate('transactions', 'create', newEntityId(), {
          type: 'expense',
          amountMinor,
          currency,
          fromAccountId: accountId,
          categoryAccountId: categoryId,
          merchantRaw: merchant || null,
          occurredAt,
          source: 'manual',
        });
        bumpRecent('odk-recent-categories-expense', categoryId);
      }
      bumpRecent('odk-recent-accounts', entryType === 'income' ? toAccountId : accountId);
      setDigits('');
      setMerchant('');
      setAmountSelected(false);
      toast('記好了 ✓');
      void reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '存檔失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function suggestCategory() {
    if (entryType === 'transfer' || !merchant.trim()) return setSuggestion(null);
    try {
      const result = await api.get<{ suggestion: { categoryAccountId: string; matches: number } | null }>(
        `/api/category-suggestion?merchant=${encodeURIComponent(merchant.trim())}&type=${entryType}`,
      );
      if (result.suggestion && categories.some((category) => category.id === result.suggestion?.categoryAccountId)) {
        setCategoryId(result.suggestion.categoryAccountId);
        setSuggestion(result.suggestion);
      } else {
        setSuggestion(null);
      }
    } catch (error) {
      console.warn('分類建議載入失敗', error instanceof Error ? error.name : 'UnknownError');
    }
  }

  const keypadKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', exponent > 0 ? '.' : '00', '0', '⌫'];

  return (
    <div className="space-y-5">
      <NetWorthCard />
      <header>
        <h1 className="odk-page-title text-2xl font-semibold">記一筆</h1>
        <p className="mt-1 text-sm text-[var(--odk-muted)]">先輸入金額，再選錢從哪裡來、去了哪裡</p>
      </header>
      <Segmented
        options={[
          { value: 'expense' as const, label: '支出' },
          { value: 'income' as const, label: '收入' },
          { value: 'transfer' as const, label: '轉帳' },
        ]}
        value={entryType}
        onChange={(v) => {
          setEntryType(v);
          setDigits('');
        }}
      />

      <div
        ref={amountRef}
        className={`odk-amount rounded-2xl px-4 py-6 text-center text-5xl font-semibold tracking-tight transition-shadow ${
          amountSelected ? 'bg-[var(--odk-accent-soft)] ring-2 ring-[var(--odk-accent)]' : 'bg-[var(--odk-surface-2)]'
        }`}
      >
        <span className="mr-1 text-2xl align-middle text-[var(--odk-muted)]">{currencyInfo(currency).symbol}</span>
        {digits || '0'}
      </div>

      <ChipRow
        label={entryType === 'transfer' ? '從哪裡轉出' : entryType === 'income' ? '收入到哪裡' : '從哪裡付'}
        items={sourceList}
        selectedId={entryType === 'income' ? toAccountId : accountId}
        onSelect={(id) => (entryType === 'income' ? setToAccountId(id) : setAccountId(id))}
      />
      {entryType === 'transfer' ? (
        <ChipRow
          label="轉到哪裡"
          items={transferTargets.filter((a) => a.id !== accountId)}
          selectedId={toAccountId}
          onSelect={setToAccountId}
        />
      ) : (
        <ChipRow
          label={entryType === 'income' ? '這筆收入算在哪一類' : '這筆錢去了哪一類'}
          items={categories}
          selectedId={categoryId}
          onSelect={(id) => { setCategoryId(id); setSuggestion(null); }}
          kind={entryType === 'income' ? 'income' : 'expense'}
          onAdd={() => setShowNewCategory(true)}
        />
      )}
      {showNewCategory && entryType !== 'transfer' ? (
        <NewCategoryDialog
          kind={entryType}
          onClose={() => setShowNewCategory(false)}
          onCreated={(id) => {
            setCategoryId(id);
            bumpRecent(`odk-recent-categories-${entryType}`, id);
          }}
        />
      ) : null}

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <TextInput
            placeholder={entryType === 'transfer' ? '備註（選填）' : '商家（選填）'}
            value={merchant}
            onChange={(e) => { setMerchant(e.target.value); setSuggestion(null); }}
            onBlur={() => void suggestCategory()}
          />
          {suggestion ? (
            <p className="mt-1 text-xs text-[var(--odk-accent)]">
              依過去 {suggestion.matches} 筆帶入「{categories.find((category) => category.id === suggestion.categoryAccountId)?.name}」，儲存前仍可改
            </p>
          ) : null}
        </div>
        <input
          type="date"
          value={dateStr}
          onChange={(e) => setDateStr(e.target.value)}
          className="min-h-10 w-full rounded-lg border border-[var(--odk-line)] bg-[var(--odk-surface)] px-3 py-2 text-sm sm:w-auto"
          aria-label="日期"
        />
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        {keypadKeys.map((key) => {
          const isBackspace = key === '⌫';
          return (
            <button
              key={key}
              type="button"
              onClick={() => (key === '00' ? (pressKey('0'), pressKey('0')) : pressKey(key))}
              className={`odk-key-shadow flex items-center justify-center rounded-2xl py-4 text-xl font-semibold transition-[transform,box-shadow,background] duration-150 active:scale-[0.95] active:shadow-none ${
                isBackspace
                  ? 'bg-[var(--odk-surface-2)] text-[var(--odk-muted)] active:bg-[color-mix(in_srgb,var(--odk-negative)_16%,var(--odk-surface-2))] active:text-[var(--odk-negative)]'
                  : 'odk-amount bg-[var(--odk-surface)] active:bg-[var(--odk-accent-soft)]'
              }`}
            >
              {isBackspace ? <Delete className="h-5 w-5" strokeWidth={2.25} /> : key}
            </button>
          );
        })}
      </div>

      <Button variant="primary" onClick={() => void save()} disabled={busy || !loaded} className="w-full py-3 text-base">
        {entryType === 'expense' ? (
          <ArrowDownCircle className="h-5 w-5" strokeWidth={2.25} />
        ) : entryType === 'income' ? (
          <ArrowUpCircle className="h-5 w-5" strokeWidth={2.25} />
        ) : (
          <ArrowLeftRight className="h-5 w-5" strokeWidth={2.25} />
        )}
        {busy ? '記錄中…' : entryType === 'expense' ? '記下這筆支出' : entryType === 'income' ? '記下這筆收入' : '記下這筆轉帳'}
      </Button>

      <PendingExpected />
    </div>
  );
}

/** 首頁淨資產一覽（M4，INV-5）：「中心引力」v2——淨資產是圓核，**每一個資產來源**
 *  （逐帳戶、逐投資帳戶、逐負債）是繞核的泡泡，大小依金額開根號。不包卡片，
 *  用融進頁面背景的光暈與點點軌道聚焦；第一眼只需要核心數字，明細點進帳戶頁。 */

const CORE_RADIUS = 60; // 核直徑 120px

// 泡泡串在正圓軌道上（珠鏈）：與畫出來的軌道同一個圓，數學上保證不會沉進核底下。
// 依實際顆數等距排開；手機放大球體後仍保留間隙，不讓第六顆「其他」蓋住第一顆。
const ORBIT_R = 120;
const MAX_BALLS = 5; // 之後的來源合併成「其他」一顆

const KIND_TINT: Record<string, string> = {
  cash: 'var(--odk-accent)',
  investment: 'var(--odk-chart-2)',
  liability: 'var(--odk-negative)',
};

/** 帳戶 chip 的顯示名：帶上所屬機構（信用卡取發卡行、其他取 institution；名稱已含就不重複） */
function accountLabel(account: AccountJson): string {
  const org =
    account.creditCard?.issuer && account.creditCard.issuer !== '—' ? account.creditCard.issuer : account.institution;
  if (org && !account.name.includes(org)) return `${org} ${account.name}`;
  return account.name;
}

/** 泡泡內金額省略幣別符號（幣別已由核心數字表達） */
function bareAmount(minorString: string, currency: string): string {
  return formatAmount(minorString, currency).replace(currencyInfo(currency).symbol, '');
}

/** 泡泡內的緊湊金額：五位數起用「萬／億」縮寫（概覽用，精確金額在帳戶頁）；BigInt 運算不經浮點 */
function compactAmount(minorString: string, currency: string): string {
  if (isPrivacyMasked()) return '•••••';
  const minor = BigInt(minorString);
  const negative = minor < 0n;
  const whole = (negative ? -minor : minor) / 10n ** BigInt(currencyInfo(currency).exponent); // 縮寫本來就捨去小數位
  if (whole < 10000n) return bareAmount(minorString, currency);
  const unit = whole >= 100000000n ? { divisor: 100000000n, suffix: '億' } : { divisor: 10000n, suffix: '萬' };
  const tenths = (whole * 10n) / unit.divisor;
  const intPart = tenths / 10n;
  const frac = tenths % 10n;
  const text = frac === 0n || intPart >= 1000n ? `${intPart}${unit.suffix}` : `${intPart}.${frac}${unit.suffix}`;
  return negative ? `−${text}` : text;
}

function NetWorthCard() {
  const [data, setData] = useState<NetWorthJson | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const netWorthRef = useRef<HTMLDivElement>(null);
  const masked = isPrivacyMasked();

  useEffect(() => {
    api.get<NetWorthJson>('/api/net-worth').then(setData).catch(() => {});
  }, []);

  const balls = useMemo(() => {
    if (!data) return [];
    const shown = netWorthBubbleSources(data.sources, MAX_BALLS);
    const max = Number(abs(BigInt(shown[0]?.contributionMinor ?? '1'))); // 只拿來算相對大小；顯示仍走字串
    return shown.map((s, i) => {
      const scale = Math.sqrt(Number(abs(BigInt(s.contributionMinor))) / max);
      const desktopDiameter = 64 + Math.round(24 * scale); // 64–88px：保留原本桌面節奏
      const mobileDiameter = 76 + Math.round(28 * scale); // 76–104px：手機觸控與三行文字更好讀
      const angle = ((-90 + (i * 360) / shown.length) * Math.PI) / 180;
      return { ...s, desktopDiameter, mobileDiameter, x: Math.cos(angle) * ORBIT_R, y: Math.sin(angle) * ORBIT_R };
    });
  }, [data]);

  useLayoutEffect(() => {
    if (!data) return;
    const netWorthTarget = Number(BigInt(data.netWorthMinor));
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      const stage = stageRef.current;
      if (!stage) return;
      const core = stage.querySelector('.odk-nw-core');
      if (core) gsap.fromTo(core, { scale: 0.88, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.35, ease: 'power2.out' });
      const orbit = stage.querySelector('.odk-nw-orbit');
      if (orbit) gsap.fromTo(orbit, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5, delay: 0.1 });
      const sats = stage.querySelectorAll('.odk-nw-sat');
      if (sats.length) {
        gsap.fromTo(sats, { scale: 0 }, { scale: 1, duration: 0.38, ease: 'back.out(1.4)', stagger: 0.06 });
        // 待機漂浮：振幅只有幾 px、方向與週期交錯——大幅慢速擺動有前庭風險，刻意做小
        sats.forEach((el, i) => {
          gsap.to(el, {
            y: (i % 2 ? -1 : 1) * (4 + (i % 3)),
            duration: 2.4 + (i % 3) * 0.6,
            ease: 'sine.inOut',
            yoyo: true,
            repeat: -1,
          });
        });
      }
      const el = netWorthRef.current;
      if (el && !isPrivacyMasked()) {
        const countUp = { v: 0 };
        gsap.to(countUp, {
          v: netWorthTarget,
          duration: 0.9,
          ease: 'power2.out',
          onUpdate: () => {
            el.textContent = formatAmount(String(Math.round(countUp.v)), data.baseCurrency);
          },
        });
      }
    });
    return () => media.revert();
  }, [data]);

  if (!data) {
    // 保留跟載入後同樣的高度，避免資料回來時整頁往下跳（ui-complexity：靜態佔位比空白更穩）
    return (
      <div className="relative h-[21.5rem]">
        <div
          className="odk-nw-core absolute left-1/2 top-1/2 animate-pulse rounded-full"
          style={{
            marginLeft: -CORE_RADIUS,
            marginTop: -CORE_RADIUS,
            width: CORE_RADIUS * 2,
            height: CORE_RADIUS * 2,
            background: 'var(--odk-accent-soft)',
          }}
          aria-hidden="true"
        />
      </div>
    );
  }
  const netWorth = BigInt(data.netWorthMinor);
  const outflow = BigInt(data.upcomingOutflow30dMinor);
  const formatted = formatAmount(data.netWorthMinor, data.baseCurrency);
  const equation = netWorthEquation(data.sources);
  // 核內數字自動縮字：以字元數估寬（tabular 半形 ≈ 0.62em），寬度預算 96px，保證不出圓
  const coreFontSize = Math.max(12, Math.min(24, Math.floor(96 / (formatted.length * 0.62))));

  return (
    <div className="relative">
      <a href="#/accounts" className="block" aria-label="淨資產總覽，點擊查看帳戶明細">
        <div ref={stageRef} className="relative h-[21.5rem]">
          {/* 不包卡片：用融進背景的光暈聚焦（ui-complexity——區隔靠光，不靠框） */}
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 rounded-full"
            style={{
              width: 340,
              height: 340,
              marginLeft: -170,
              marginTop: -170,
              background: 'radial-gradient(closest-side, var(--odk-accent-soft) 0%, transparent 72%)',
            }}
          />
          {/* 點點軌道：可愛版的分隔線；球的中心點就落在這個正圓上（珠鏈） */}
          <svg
            className="odk-nw-orbit pointer-events-none absolute left-1/2 top-1/2"
            width="250"
            height="250"
            style={{ marginLeft: -125, marginTop: -125 }}
            aria-hidden="true"
          >
            <circle
              cx="125"
              cy="125"
              r={ORBIT_R}
              fill="none"
              stroke="color-mix(in srgb, var(--odk-accent) 30%, transparent)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray="0.1 11"
            />
          </svg>
          {balls.map((s, i) => (
            <div
              key={s.accountId}
              className="odk-nw-sat absolute z-[5] flex flex-col items-center justify-center overflow-hidden rounded-full text-center"
              style={{
                left: '50%',
                top: '50%',
                '--odk-ball-mobile': `${s.mobileDiameter}px`,
                '--odk-ball-desktop': `${s.desktopDiameter}px`,
                '--odk-ball-x': `${s.x}px`,
                '--odk-ball-y': `${s.y}px`,
                willChange: 'transform',
                background: s.others
                  ? 'color-mix(in srgb, var(--odk-muted) 20%, var(--odk-surface))'
                  : `radial-gradient(120% 120% at 30% 22%, hsl(0 0% 100% / 0.3) 0%, transparent 40%), color-mix(in srgb, ${KIND_TINT[s.kind]} ${24 + (i % 3) * 6}%, var(--odk-surface))`,
              } as CSSProperties}
            >
              {s.institution && !s.name.includes(s.institution) ? (
                <div className="max-w-full truncate px-1.5 text-[10px] leading-tight text-[var(--odk-muted)] sm:text-[9px]">{s.institution}</div>
              ) : null}
              <div className="max-w-full truncate px-1.5 text-xs font-medium leading-tight sm:text-[11px]">{s.name}</div>
              <div
                className={`odk-amount max-w-full px-1 text-sm font-semibold leading-tight sm:text-xs ${s.deduction ? 'text-[var(--odk-negative)]' : ''}`}
              >
                {compactAmount(s.contributionMinor, data.baseCurrency)}
              </div>
            </div>
          ))}
          <div
            className="odk-nw-core absolute left-1/2 top-1/2 z-10 flex flex-col items-center justify-center rounded-full bg-[var(--odk-surface)] text-center"
            style={{ marginLeft: -CORE_RADIUS, marginTop: -CORE_RADIUS, width: CORE_RADIUS * 2, height: CORE_RADIUS * 2, boxShadow: 'var(--odk-shadow)', willChange: 'transform' }}
          >
            <div className="text-[11px] font-medium text-[var(--odk-muted)]">淨資產</div>
            <div
              ref={netWorthRef}
              className={`odk-amount mt-0.5 max-w-full px-2 font-semibold tracking-tight ${netWorth < 0n ? 'text-[var(--odk-negative)]' : ''}`}
              style={{ fontSize: coreFontSize }}
            >
              {formatted}
            </div>
          </div>
        </div>
        <div className="mt-1 flex flex-wrap justify-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--odk-muted)]">
          {outflow > 0n ? <span>未來 30 天預計支出 {formatAmount(data.upcomingOutflow30dMinor, data.baseCurrency)}</span> : null}
          <span>{data.oldestDataAsOf ? `匯率／報價更新於 ${relativeDays(data.oldestDataAsOf)}` : '資料即時'}</span>
          {data.incomplete ? <span className="text-[var(--odk-signal)]">部分金額缺匯率或報價</span> : null}
        </div>
        <div className="mt-1 text-center text-xs text-[var(--odk-muted)]">
          資產 {formatAmount(equation.assetsMinor.toString(), data.baseCurrency)}
          {' − '}負債／負餘額 {formatAmount(equation.deductionsMinor.toString(), data.baseCurrency)}
          {' = '}淨資產 {formatAmount(data.netWorthMinor, data.baseCurrency)}
        </div>
      </a>
      <button
        type="button"
        onClick={togglePrivacyMask}
        aria-label={masked ? '顯示金額' : '隱藏金額'}
        className="absolute right-1 top-0 z-20 rounded-full p-2 text-[var(--odk-muted)] transition-[background,transform] duration-150 hover:bg-[var(--odk-surface-2)] active:scale-95"
      >
        {masked ? <EyeOff className="h-4 w-4" strokeWidth={2.25} /> : <Eye className="h-4 w-4" strokeWidth={2.25} />}
      </button>
    </div>
  );
}

function relativeDays(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return '今天';
  return `${days} 天前`;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function ChipRow({
  label,
  items,
  selectedId,
  onSelect,
  kind,
  onAdd,
}: {
  label: string;
  items: AccountJson[];
  selectedId: string;
  onSelect: (id: string) => void;
  kind?: 'income' | 'expense';
  onAdd?: () => void;
}) {
  const iconRefs = useRef<Record<string, HTMLSpanElement | null>>({});

  useLayoutEffect(() => {
    if (!kind) return;
    const el = iconRefs.current[selectedId];
    if (!el) return;
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(el, { scale: 0.5, rotate: -15 }, { scale: 1, rotate: 0, duration: 0.32, ease: 'back.out(2)' });
    });
    return () => media.revert();
  }, [selectedId, kind]);

  return (
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--odk-muted)]">{label}</div>
      <div
        role="group"
        aria-label={label}
        className="-mx-1 flex snap-x snap-proximity flex-nowrap gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-wrap sm:gap-1.5 sm:overflow-visible sm:px-0 sm:pb-0"
      >
        {items.length === 0 ? (
          <span className="text-sm text-[var(--odk-muted)]">還沒有可用項目——到「帳戶」頁建立</span>
        ) : (
          items.map((item) => {
            const Icon = kind ? categoryIcon(item.name, kind) : null;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                className={`flex shrink-0 snap-start items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors sm:snap-none ${
                  item.id === selectedId
                    ? 'border-[var(--odk-accent)] bg-[var(--odk-accent)] text-white'
                    : 'border-[var(--odk-line)] bg-[var(--odk-surface)] text-[var(--odk-text)]'
                }`}
              >
                {Icon ? (
                  <span
                    ref={(el) => {
                      iconRefs.current[item.id] = el;
                    }}
                    className="inline-flex"
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
                  </span>
                ) : null}
                {kind ? item.name : accountLabel(item)}
              </button>
            );
          })
        )}
        {onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            className="shrink-0 snap-start rounded-full bg-[var(--odk-surface-2)] px-3 py-1.5 text-sm text-[var(--odk-muted)] transition-colors hover:text-[var(--odk-text)] sm:snap-none"
          >
            ＋ 自訂
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 自訂分類（後端 M1 起就支援，這裡補記一筆頁的入口）：原地建立，不打斷輸入到一半的金額 */
function NewCategoryDialog({
  kind,
  onClose,
  onCreated,
}: {
  kind: 'income' | 'expense';
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { reload } = useAccounts();
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return toast('先輸入分類名稱', 'error');
    setBusy(true);
    try {
      const id = newEntityId();
      await mutate('accounts', 'create', id, {
        name: trimmed,
        subtype: kind === 'income' ? 'category_income' : 'category_expense',
        currency: 'TWD',
      });
      await reload();
      onCreated(id);
      toast(`已建立「${trimmed}」✓`);
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '建立失敗', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={kind === 'income' ? '自訂收入分類' : '自訂支出分類'}>
      <div className="space-y-3">
        <Field label="名稱">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === 'income' ? '例如：獎金' : '例如：健身'}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? '建立中…' : '建立'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** F5（M1 手動）：待確認的預計交易 */
function PendingExpected() {
  const { accounts, reload: reloadAccounts } = useAccounts();
  const toast = useToast();
  const [expected, setExpected] = useState<ExpectedJson[]>([]);
  const [rules, setRules] = useState<RecurringRuleJson[]>([]);

  async function load() {
    const data = await api.get<{ rules: RecurringRuleJson[]; expected: ExpectedJson[] }>('/api/recurring');
    setRules(data.rules);
    setExpected(data.expected);
  }
  useEffect(() => {
    void load().catch(() => {});
  }, []);

  const due = expected.filter((e) => e.expectedDate <= todayLocalDate());
  if (due.length === 0) return null;

  async function confirm(item: ExpectedJson) {
    const rule = rules.find((r) => r.id === item.ruleId);
    try {
      if (rule?.kind === 'invest_buy') {
        // 定期定額（圈存）：要填實際成交金額與股數，走週期頁的確認對話框
        location.hash = '#/recurring';
        return;
      }
      if (!rule?.categoryAccountId || !item.amountMinor) {
        toast('這筆需要補分類或金額，請到「週期」頁處理', 'error');
        return;
      }
      const txnId = newEntityId();
      await mutate('transactions', 'create', txnId, {
        type: 'expense',
        amountMinor: item.amountMinor,
        currency: item.currency,
        fromAccountId: item.accountId,
        categoryAccountId: rule.categoryAccountId,
        merchantRaw: rule.merchantHint ?? rule.name,
        occurredAt: new Date().toISOString(),
        expectedTransactionId: item.id,
        recurringRuleId: rule.id,
        source: 'recurring',
      });
      await mutate('expected_transactions', 'update', item.id, { status: 'confirmed', matchedTransactionId: txnId }, item.version);
      toast(`已確認 ${rule.name} ✓`);
      await load();
      void reloadAccounts();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '確認失敗', 'error');
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-[var(--odk-line)] bg-[var(--odk-surface)]">
      <h2 className="border-b border-[var(--odk-line)] px-3 py-2 text-sm font-medium">待確認扣款</h2>
      <ul className="divide-y divide-[var(--odk-line)]">
        {due.map((item) => {
          const rule = rules.find((r) => r.id === item.ruleId);
          const account = accounts.find((a) => a.id === item.accountId);
          return (
            <li key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <div className="min-w-0">
                <div>{rule?.name ?? '預計交易'}</div>
                <div className="text-xs text-[var(--odk-muted)]">
                  {item.expectedDate} · {account?.name}
                </div>
              </div>
              <span className="odk-amount text-right">{item.amountMinor ? formatAmount(item.amountMinor, item.currency) : '金額待定'}</span>
              <Button variant="primary" className="col-span-2 justify-center px-2.5 py-1 text-xs sm:col-span-1" onClick={() => void confirm(item)}>
                確認
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function todayLocalDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function combineDateWithNow(dateStr: string): string {
  const now = new Date();
  if (dateStr === todayLocalDate()) return now.toISOString();
  // 過去日期：取當天中午（避免時區邊界落錯天）
  return new Date(`${dateStr}T12:00:00`).toISOString();
}
