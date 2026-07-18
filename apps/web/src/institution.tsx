import { Field, Select, TextInput } from '@okane-dokoitta/ui';
import { useState } from 'react';

/** 機構下拉清單（顯示層便利選項，非 domain 資料）；不在清單內選「其他」自行輸入 */

export const TAIWAN_BANKS = [
  '國泰世華',
  '中國信託',
  '玉山銀行',
  '台新銀行',
  '台北富邦',
  '永豐銀行',
  '聯邦銀行',
  '第一銀行',
  '華南銀行',
  '兆豐銀行',
  '彰化銀行',
  '合作金庫',
  '台灣銀行',
  '土地銀行',
  '上海商銀',
  '遠東商銀',
  '元大銀行',
  '凱基銀行',
  '樂天銀行',
  '連線銀行 LINE Bank',
  '將來銀行',
  '王道銀行',
  '中華郵政',
];

export const TAIWAN_BROKERS = [
  '元大證券',
  '凱基證券',
  '富邦證券',
  '永豐金證券',
  '國泰證券',
  '群益金鼎證券',
  '統一證券',
  '兆豐證券',
  '華南永昌證券',
  '元富證券',
  '玉山證券',
  '台新證券',
  '第一金證券',
  '合庫證券',
  '康和證券',
  '口袋證券',
];

/** 機構選單：常見機構下拉＋「其他」自填，省掉多數人的打字 */
export function InstitutionSelect({
  value,
  onChange,
  label,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  options: readonly string[];
}) {
  const [custom, setCustom] = useState(value !== '' && !options.includes(value));
  return (
    <Field label={label}>
      <div className="space-y-2">
        <Select
          value={custom ? '__other__' : value}
          onChange={(e) => {
            if (e.target.value === '__other__') {
              setCustom(true);
              onChange('');
            } else {
              setCustom(false);
              onChange(e.target.value);
            }
          }}
        >
          <option value="">選擇機構</option>
          {options.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
          <option value="__other__">其他（自行輸入）</option>
        </Select>
        {custom ? <TextInput value={value} onChange={(e) => onChange(e.target.value)} placeholder="機構名稱" /> : null}
      </div>
    </Field>
  );
}
