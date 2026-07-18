import {
  BookOpen,
  Briefcase,
  Car,
  Gamepad2,
  Gift,
  HeartPulse,
  Home,
  Key,
  Landmark,
  Laptop,
  MoreHorizontal,
  Package,
  PartyPopper,
  PawPrint,
  Plane,
  Receipt,
  Repeat,
  Shield,
  Shirt,
  ShoppingBag,
  ShoppingCart,
  TrendingUp,
  Utensils,
  Wallet,
  Wifi,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/** 分類 icon（lucide SVG，跨平台顯示一致，也方便日後用 gsap 對 stroke/scale 做動畫）。 */
const EXPENSE_ICONS: Record<string, LucideIcon> = {
  外食: Utensils,
  生鮮雜貨: ShoppingCart,
  交通: Car,
  居住: Home,
  水電瓦斯: Zap,
  通訊網路: Wifi,
  日用品: ShoppingBag,
  醫療保健: HeartPulse,
  保險: Shield,
  教育學習: BookOpen,
  娛樂: Gamepad2,
  訂閱: Repeat,
  旅遊: Plane,
  服飾美容: Shirt,
  寵物: PawPrint,
  稅費與手續費: Receipt,
  人情與捐贈: Gift,
  其他支出: Package,
};

const INCOME_ICONS: Record<string, LucideIcon> = {
  薪資: Briefcase,
  獎金: PartyPopper,
  接案: Laptop,
  利息: Landmark,
  股息: TrendingUp,
  租金: Key,
  其他收入: Wallet,
};

export function categoryIcon(name: string, kind: 'income' | 'expense'): LucideIcon {
  const table = kind === 'income' ? INCOME_ICONS : EXPENSE_ICONS;
  return table[name] ?? (kind === 'income' ? Wallet : MoreHorizontal);
}
