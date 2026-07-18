/**
 * 使用者自訂主題色（相位角，0–359）：飽和度/明度沿用既有湖綠色系的配方，
 * 只換色相，確保無論選哪個顏色，深淺色對比與可讀性都不會跑掉。
 */
const STORAGE_KEY = 'odk-accent-hue';
const STYLE_ID = 'odk-accent-override';

export function getAccentHue(): number | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  const hue = Number(raw);
  return Number.isFinite(hue) ? hue : null;
}

export function applyAccentHue(hue: number | null): void {
  if (hue === null) {
    localStorage.removeItem(STORAGE_KEY);
    document.getElementById(STYLE_ID)?.remove();
    return;
  }
  const h = Math.round(((hue % 360) + 360) % 360);
  localStorage.setItem(STORAGE_KEY, String(h));
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.append(style);
  }
  // 168 是滑桿預設（湖綠）的相位角；用同一個 delta 旋轉背景系變數的色相，
  // 讓背景跟著主題色一起變，飽和度/明度仍沿用 theme.css 的配方（可讀性不變）。
  const delta = h - 168;
  const rotate = (base: number) => Math.round(((base + delta) % 360 + 360) % 360);
  style.textContent = `
    :root {
      --odk-accent: hsl(${h} 58% 30%);
      --odk-accent-soft: hsl(${rotate(164)} 48% 89%);
      --odk-bg: hsl(${rotate(164)} 38% 97%);
      --odk-surface-2: hsl(${rotate(164)} 34% 92%);
      --odk-line: hsl(${rotate(168)} 20% 82%);
      --odk-chart-2: hsl(${rotate(318)} 55% 42%);
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme='light']) {
        --odk-accent: hsl(${h} 54% 65%);
        --odk-accent-soft: hsl(${rotate(169)} 30% 22%);
        --odk-bg: hsl(${rotate(176)} 29% 9%);
        --odk-surface-2: hsl(${rotate(174)} 23% 19%);
        --odk-line: hsl(${rotate(173)} 17% 30%);
        --odk-chart-2: hsl(${rotate(318)} 55% 68%);
      }
    }
    :root[data-theme='dark'] {
      --odk-accent: hsl(${h} 54% 65%);
      --odk-accent-soft: hsl(${rotate(169)} 30% 22%);
      --odk-bg: hsl(${rotate(176)} 29% 9%);
      --odk-surface-2: hsl(${rotate(174)} 23% 19%);
      --odk-line: hsl(${rotate(173)} 17% 30%);
      --odk-chart-2: hsl(${rotate(318)} 55% 68%);
    }
  `;
}
