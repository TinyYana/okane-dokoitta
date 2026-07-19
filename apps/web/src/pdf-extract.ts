import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * 瀏覽器端抽 PDF 文字層——不上傳原始檔案。銀行 PDF 排版（多欄、頁首頁尾）常把文字抽亂，
 * 抽出來的原始文字沿用既有「貼上文字」匯入路徑，交給 AI 整理或使用者手動修再送審計。
 * 掃描圖檔（沒有文字層）抽不出東西，呼叫端要處理空字串／拋出的錯誤。
 */
export async function extractPdfText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
      } finally {
        page.cleanup();
      }
    }
    return pages.join('\n').trim();
  } finally {
    await loadingTask.destroy();
  }
}
