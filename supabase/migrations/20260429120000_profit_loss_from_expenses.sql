-- «Прибыль и убыток (пр.лет)» — из таблицы expenses (категория «Прибыль убыток»), не из pnl_monthly_values.

UPDATE public.pnl_structure
SET
  type     = 'category',
  category = 'Прибыль убыток'
WHERE key = 'profit_loss_prev_years';

DELETE FROM public.pnl_monthly_values WHERE metric = 'profit_loss_prev_years';
