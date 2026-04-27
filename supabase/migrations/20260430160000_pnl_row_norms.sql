-- Нормативы %% для строк верхнего уровня P&L: маржинальная прибыль, чистая прибыль.

CREATE TABLE public.pnl_row_norms (
  row_key                   TEXT PRIMARY KEY
    CHECK (row_key IN ('gross_margin', 'net_profit')),
  norm_percent              NUMERIC(8, 4) NULL,
  norm_percent_of_revenue   NUMERIC(8, 4) NULL,
  attention_of_norm_pct     NUMERIC(6, 2) NOT NULL DEFAULT 110,
  critical_of_norm_pct      NUMERIC(6, 2) NOT NULL DEFAULT 125,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pnl_row_norms_gm_no_rev_pct CHECK (
    row_key <> 'gross_margin' OR norm_percent_of_revenue IS NULL
  ),
  CONSTRAINT pnl_row_norms_has_some_norm CHECK (
    norm_percent IS NOT NULL OR norm_percent_of_revenue IS NOT NULL
  ),
  CONSTRAINT pnl_row_norms_thresholds CHECK (
    attention_of_norm_pct > 100
    AND critical_of_norm_pct > attention_of_norm_pct
  )
);

COMMENT ON TABLE public.pnl_row_norms IS 'Целевые %% для МАРЖИНАЛЬНОЙ ПРИБЫЛИ и Чистой прибыли; пороги как у категорий';
COMMENT ON COLUMN public.pnl_row_norms.norm_percent IS 'gross_margin: %% от выручки; net_profit: %% от маржи (первая колонка %%)';
COMMENT ON COLUMN public.pnl_row_norms.norm_percent_of_revenue IS 'Только net_profit: норма %% от выручки (вторая строка %%)';

create or replace trigger trg_pnl_row_norms_updated_at
  before update on public.pnl_row_norms
  for each row
  execute function public.set_updated_at();
