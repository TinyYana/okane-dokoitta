/**
 * 商家關鍵字 → 預設分類名稱的規則表（無使用者歷史可查時的第二層猜測，排在 history 之後、
 * 通用 fallback 之前）。只匹配英數字辨識度高、不容易誤判的品牌／字面標記；避免像 "SUB" 這種
 * 短字串連到 SUBWAY 之類的字裡去，用 \b 詞界線鎖住。
 */
interface KeywordRule {
  category: string;
  pattern: RegExp;
}

const KEYWORD_RULES: readonly KeywordRule[] = [
  // 訂閱：帳單上常見的「這是訂閱扣款」字面標記
  { category: '訂閱', pattern: /\bSUBR?\b/i },
  { category: '訂閱', pattern: /\bSUBSCR(IPTION)?\b/i },
  { category: '訂閱', pattern: /\bRECURRING\b/i },
  // 訂閱：常見串流／雲端／軟體訂閱品牌
  { category: '訂閱', pattern: /NETFLIX/i },
  { category: '訂閱', pattern: /SPOTIFY/i },
  { category: '訂閱', pattern: /YOUTUBE ?PREMIUM/i },
  { category: '訂閱', pattern: /DISNEY\+?/i },
  { category: '訂閱', pattern: /\bHBO ?(MAX|GO)?\b/i },
  { category: '訂閱', pattern: /APPLE\.COM\/BILL/i },
  { category: '訂閱', pattern: /\bICLOUD\b/i },
  { category: '訂閱', pattern: /GOOGLE ?(ONE|STORAGE|PLAY PASS)/i },
  { category: '訂閱', pattern: /\bKKBOX\b/i },
  { category: '訂閱', pattern: /\bMYVIDEO\b/i },
  { category: '訂閱', pattern: /FRIDAY ?(影音)?/i },
  { category: '訂閱', pattern: /\bMYMUSIC\b/i },
  { category: '訂閱', pattern: /\bADOBE\b/i },
  { category: '訂閱', pattern: /\bOPENAI\b|CHATGPT/i },
  { category: '訂閱', pattern: /GITHUB ?(COPILOT)?/i },
  { category: '訂閱', pattern: /\bNOTION\b/i },
  { category: '訂閱', pattern: /\bDROPBOX\b/i },
  { category: '訂閱', pattern: /\bLINE ?TV\b/i },
  { category: '訂閱', pattern: /AMAZON ?PRIME/i },
  // 娛樂：遊戲平台／電影院／KTV
  { category: '娛樂', pattern: /\bSTEAM\b/i },
  { category: '娛樂', pattern: /PLAYSTATION|\bPSN\b/i },
  { category: '娛樂', pattern: /NINTENDO/i },
  { category: '娛樂', pattern: /\bXBOX\b/i },
  { category: '娛樂', pattern: /EPIC ?GAMES/i },
  { category: '娛樂', pattern: /威秀|國賓影城|新光影城|秀泰|美麗華影城|環球影城/ },
  { category: '娛樂', pattern: /錢櫃|好樂迪|銀櫃/ },
];

/** 依商家原始字串猜分類名稱；找不到規則回傳 null（不代表要 fallback 到「其他支出」，那是呼叫端的事）。 */
export function categorizeByKeyword(merchantRaw: string): string | null {
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(merchantRaw)) return rule.category;
  }
  return null;
}
