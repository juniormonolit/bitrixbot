-- Нормативы по категориям расходов для подсветки в P&L (% и/или сумма за месяц).

CREATE TABLE public.pnl_category_norms (
  category     TEXT PRIMARY KEY REFERENCES public.expense_categories (name) ON DELETE CASCADE,
  norm_percent NUMERIC(8, 4) NULL,
  norm_amount  NUMERIC(14, 2) NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pnl_category_norms_at_least_one
    CHECK (norm_percent IS NOT NULL OR norm_amount IS NOT NULL)
);

COMMENT ON TABLE public.pnl_category_norms IS 'Целевые % (от валовой прибыли) и/или суммы (₽/мес) для подсветки строк категорий в P&L';
COMMENT ON COLUMN public.pnl_category_norms.norm_percent IS 'Норматив в процентах, например 20 = 20%% от валовой; зелёный если факт ≤ норматива';
COMMENT ON COLUMN public.pnl_category_norms.norm_amount IS 'Норматив в рублях за месяц; зелёный если факт ≤ норматива';

create or replace trigger trg_pnl_category_norms_updated_at
  before update on public.pnl_category_norms
  for each row
  execute function public.set_updated_at();
