export interface QuoteSecurity {
  symbol: string;
  market: string;
  currency: string;
}

export interface AutomaticQuote {
  price: string;
  asOf: Date;
  provider: 'twse' | 'finnhub';
}

export class MarketDataError extends Error {
  constructor(
    readonly code: 'PROVIDER_NOT_CONFIGURED' | 'MARKET_UNSUPPORTED' | 'QUOTE_NOT_FOUND' | 'PROVIDER_FAILED',
    message: string,
  ) {
    super(message);
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * 自動報價來源（ADR-008）：
 * - 臺灣上市證券：臺灣證券交易所 OpenAPI，不需要金鑰。
 * - 美國證券：Finnhub Quote API，金鑰由架設者以環境變數提供。
 */
export async function fetchAutomaticQuote(
  security: QuoteSecurity,
  finnhubToken: string | null,
  fetcher: FetchLike = fetch,
): Promise<AutomaticQuote> {
  const market = security.market.trim().toUpperCase();
  const currency = security.currency.trim().toUpperCase();
  const symbol = security.symbol.trim().toUpperCase();

  if (currency === 'TWD' && ['TW', 'TWSE'].includes(market)) {
    const response = await providerFetch(
      fetcher,
      'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL',
      { headers: { accept: 'application/json' } },
    );
    const rows = (await response.json().catch(() => null)) as Array<Record<string, unknown>> | null;
    if (!Array.isArray(rows)) throw new MarketDataError('PROVIDER_FAILED', '臺灣證券交易所回傳了無法辨識的資料');
    const row = rows.find((item) => String(item['Code'] ?? item['code'] ?? '').trim().toUpperCase() === symbol);
    const price = decimalValue(row?.['ClosingPrice'] ?? row?.['closingPrice']);
    if (!price) throw new MarketDataError('QUOTE_NOT_FOUND', `臺灣證券交易所目前找不到 ${symbol} 的收盤價`);
    const asOf = twseAsOf(row, response.headers);
    if (!asOf) throw new MarketDataError('PROVIDER_FAILED', '臺灣證券交易所報價缺少可信的交易日期');
    return { price, asOf, provider: 'twse' };
  }

  if (currency === 'USD' && ['US', 'NYSE', 'NASDAQ', 'AMEX'].includes(market)) {
    if (!finnhubToken) {
      throw new MarketDataError(
        'PROVIDER_NOT_CONFIGURED',
        '美股自動報價尚未設定；架設者需設定 OKANE_DOKOITTA_FINNHUB_TOKEN',
      );
    }
    const response = await providerFetch(
      fetcher,
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`,
      { headers: { accept: 'application/json', 'x-finnhub-token': finnhubToken } },
    );
    const body = (await response.json().catch(() => null)) as { c?: unknown; t?: unknown } | null;
    const price = decimalValue(body?.c);
    if (!price) throw new MarketDataError('QUOTE_NOT_FOUND', `Finnhub 目前找不到 ${symbol} 的美股報價`);
    const asOf = unixSeconds(body?.t);
    if (!asOf) throw new MarketDataError('PROVIDER_FAILED', 'Finnhub 報價缺少可信的行情時間');
    return { price, asOf, provider: 'finnhub' };
  }

  throw new MarketDataError(
    'MARKET_UNSUPPORTED',
    `目前尚未支援 ${security.market}/${security.currency} 的自動報價；可更新標的市場與幣別後再試`,
  );
}

async function providerFetch(fetcher: FetchLike, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new MarketDataError('PROVIDER_FAILED', '報價來源目前無法連線');
  }
  if (!response.ok) {
    throw new MarketDataError('PROVIDER_FAILED', `報價來源回應 ${response.status}`);
  }
  return response;
}

function decimalValue(value: unknown): string | null {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).replaceAll(',', '').trim() : '';
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) || /^0(?:\.0+)?$/.test(text)) return null;
  return text;
}

function unixSeconds(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function twseAsOf(row: Record<string, unknown> | undefined, headers: Headers): Date | null {
  const raw = String(row?.['Date'] ?? row?.['date'] ?? '').trim();
  const digits = raw.replaceAll(/[^0-9]/g, '');
  if (digits.length === 8) return taipeiCivilDate(digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8));
  if (digits.length === 7) return taipeiCivilDate(String(Number(digits.slice(0, 3)) + 1911), digits.slice(3, 5), digits.slice(5, 7));
  const lastModified = headers.get('last-modified');
  if (!lastModified) return null;
  const parsed = new Date(lastModified);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function taipeiCivilDate(year: string, month: string, day: string): Date | null {
  const date = new Date(`${year}-${month}-${day}T00:00:00+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}
