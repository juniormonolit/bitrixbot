-- Единый стиль подписей строк P&L: без КАПС, «итого» строчными, 1С, «(все)».

UPDATE public.pnl_structure SET name = 'Выручка итого' WHERE key = 'revenue';
UPDATE public.pnl_structure SET name = 'Маржинальная прибыль' WHERE key = 'gross_margin';
UPDATE public.pnl_structure SET name = 'Себестоимость итого' WHERE key = 'cogs';
UPDATE public.pnl_structure SET name = 'Валовая прибыль' WHERE key = 'gross_profit';
UPDATE public.pnl_structure SET name = 'Расходы в 1С' WHERE key = 'expenses_in_1c';
UPDATE public.pnl_structure SET name = 'Расходы (все)' WHERE key = 'expenses_all';

UPDATE public.pnl_settings
SET description = 'Выручка итого × X'
WHERE key = 'tax_rate_cashless' AND description = 'Выручка ИТОГО × X';
