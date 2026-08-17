/** Locale namespace owned by the balance capsule. */
export const NS = 'balance-indicator'

/** Simplified-Chinese balance capsule strings. */
export const zh = {
  'capsule.amount': '余额 {symbol}{amount}',
  'capsule.refreshTitle': '点击刷新余额',
} as const

/** English balance capsule strings. */
export const en: Record<keyof typeof zh, string> = {
  'capsule.amount': 'Balance {symbol}{amount}',
  'capsule.refreshTitle': 'Click to refresh the balance',
}

/** Stable locale keys consumed by the capsule. */
export type BalanceIndicatorKey = keyof typeof zh
