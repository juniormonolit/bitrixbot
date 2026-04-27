/** Canonical list of expense categories for the P&L app.
 *  These values match the category names exported from Excel / 1C.
 */
export const EXPENSE_CATEGORIES = [
  'ЗП МЕН',
  'ЗП РОП',
  'ЗП ЛОГ',
  'Маркетинг',
  'Колл-центр',
  'Аренда',
  'Склад',
  'Бухгалтерия',
  'ХОЗ',
  'Найм',
  'Адаптация и мотивация',
  'Банк',
  'АЙТИ',
  'Прочие расходы',
  'Юр услуги и без',
  'Курьеры',
  'Разработка IT',
  'Налог за ЗП',
  'Налоги за безнал',
  'Прибыль убыток',
] as const

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]
