# IMPORTER_SYSTEM — 帳單匯入器插件系統

相關 ADR：ADR-007。實作 package：`packages/importers`。

## 1. 原則

- 每個來源一個 importer，in-repo、同一 interface、附 fixture 測試（ADR-007）。
- Importer 只負責「外部格式 → NormalizedStatement」，**不碰資料庫、不做配對**——那是 audit-engine 的事。
- 匯入的原始資料完整保留（`statement_items.raw`），解析錯誤可回溯。
- 金額在 importer 層就轉成整數最小單位；轉不動（格式意外）就 fail 該行並回報，不猜。

## 2. 目錄與註冊

```text
packages/importers/
  src/
    types.ts            # 介面與 NormalizedStatement 定義
    registry.ts         # 所有 importer 的註冊表
    generic-csv/        # 通用 CSV（欄位對應精靈）
    generic-text/       # 貼上文字（行解析規則）
    generic-pdf/        # PDF 文字層抽取 → generic-text 管線
    moze-export/        # MOZE 記帳匯出
    cathay-credit-card/ # 國泰信用卡帳單
    union-bank-credit-card/ # 聯邦銀行信用卡 CSV（已實作）
    line-bank/
  fixtures/<importer-id>/   # 去識別化樣本 + 預期輸出 JSON
```

## 3. 介面

```ts
type Importer = {
  id: string;                      // 'cathay-credit-card'
  displayName: string;
  accepts: ('csv' | 'pdf' | 'text')[];
  /** 嗅探輸入是否屬於此 importer；分數最高者中選，皆低分→請使用者手選 */
  detect(input: ImportInput): number;          // 0..1
  parse(input: ImportInput): Promise<ParseResult>;
};

type ImportInput =
  | { kind: 'csv'; text: string; filename?: string }
  | { kind: 'text'; text: string }
  | { kind: 'pdf'; extractedText: string; filename?: string };
  // PDF → 文字抽取由共用前置步驟完成，importer 拿到的是文字

type ParseResult = {
  statement: NormalizedStatement;
  warnings: ParseWarning[];        // 跳過的行、猜測的欄位——全部可見
};

type NormalizedStatement = {
  importerId: string;
  institution?: string;
  cardLast4?: string;
  periodStart?: string;            // YYYY-MM-DD
  periodEnd?: string;
  statementDate?: string;
  dueDate?: string;
  totalMinor?: bigint;             // 帳單聲稱的總額；金額永不進 JS number
  currency: string;
  transactions: ImportedTransaction[];
};

type ImportedTransaction = {
  sourceId?: string;
  institution?: string;
  accountHint?: string;
  cardLast4?: string;
  occurredAt?: string;
  postedAt?: string;
  merchantRaw: string;
  merchantNormalized?: string;
  amountMinor: bigint;             // 整數最小貨幣單位，簽名：消費為正、退款為負
  currency: string;
  type?: string;                   // 'purchase' | 'refund' | 'fee' | 'installment' | ...
  installment?: { current: number; total: number };
  metadata: Record<string, unknown>;   // 原始欄位全塞這裡
};
```

## 4. 匯入流程

```text
上傳/貼上 → PDF？→ 共用文字抽取（無文字層→M6 前直接回報「請貼上文字」，不 OCR）
→ registry.detect() 排序 → 最高分 importer（或使用者手選）
→ parse() + 資料模型驗證 → NormalizedStatement + warnings
→ 驗證通過後 import_files 加密落地（見 SECURITY §6；失敗輸入不留 orphan 原始檔）
→ 單卡：建立 statement + statement_items（raw 保留）
→ 銀行合併多卡：建立 statement_group，再依末四碼建立每卡 statement + audit session（ADR-010）
→ 交給 audit session（見 AUDIT_ENGINE）
```

- 手動輸入帳單（總額 + 逐筆明細）走同一條路：UI 產生 NormalizedStatement，等同一個「手動 importer」。
- `NormalizedStatement` contract 允許通用交易清單缺少 `totalMinor`；但目前 M3 的 `statements.total_minor` 仍為必填，audit UI/API 會要求手動補總額。真正「無總額跳過驗證」尚未落地，不得宣稱已支援。

## 5. 安全限制

- 解析在 worker 角色內跑，有 timeout（30s）與記憶體上限；解析器不得執行輸入內容（CSV injection：匯出時所有欄位防公式前綴；PDF 只抽文字層，不執行 JS）。
- 上傳檔案生命週期見 `docs/SECURITY.md` §6。
- 不做：網銀登入、爬取、發票 API（AUDIT-8）。

## 6. 新增 importer 的完成定義

1. 實作 `Importer` 介面 + `detect()`。
2. `fixtures/` 至少 2 個去識別化樣本（正常 + 含分期/退款等邊角）與預期輸出 JSON。
3. 樣本必須去識別化：假卡號末四碼、假商家可以，**真實個資不得進 repo**。
4. 註冊進 registry；`pnpm test` 綠燈。

## 7. 待作者提供

聯邦銀行 CSV importer 已依作者提供的 2026-07 帳單完成格式解析，支援帳單摘要在第一列、交易表頭在第三列、民國年日期與多張卡片區段；repository 只保留人工改寫的去識別 fixture。API 以使用者自己的「聯邦銀行＋末四碼」唯一映射卡片，原始檔只存一次，合併應繳放 `statement_groups`，每卡明細另建審計；缺卡或末四碼不唯一時明確拒絕，不猜。國泰與 LINE Bank 仍需作者提供樣本（OPEN_QUESTIONS Q9）；MOZE 需匯出檔樣本（Q8）。

銀行專用 importer 由 registry 自動偵測。無專用 importer 時仍回退 generic-csv / generic-text，並要求使用者補帳單日期與總額；不得用模糊欄位猜測取代來源 fixture。
