import { createRoot } from 'react-dom/client';
import { getAccentHue, applyAccentHue } from './accent.js';
import { App } from './app.jsx';
import './theme.css';

// 主題：手動設定存 localStorage；未設定時 CSS 跟隨系統（PWA-3）
const theme = localStorage.getItem('odk-theme');
if (theme === 'light' || theme === 'dark') {
  document.documentElement.dataset['theme'] = theme;
}

// 使用者自訂主題色：未設定時維持預設湖綠色（theme.css）
const accentHue = getAccentHue();
if (accentHue !== null) applyAccentHue(accentHue);

createRoot(document.getElementById('root')!).render(<App />);
