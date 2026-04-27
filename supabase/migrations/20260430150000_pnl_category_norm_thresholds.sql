-- Пороги «внимание» и «критично» как %% от нормы (110 = факт/норма > 1.10 → зона после жёлтого).

ALTER TABLE public.pnl_category_norms
  ADD COLUMN IF NOT EXISTS attention_of_norm_pct NUMERIC(6, 2) NOT NULL DEFAULT 110,
  ADD COLUMN IF NOT EXISTS critical_of_norm_pct NUMERIC(6, 2) NOT NULL DEFAULT 125;

ALTER TABLE public.pnl_category_norms
  DROP CONSTRAINT IF EXISTS pnl_category_norms_thresholds_ok;

ALTER TABLE public.pnl_category_norms
  ADD CONSTRAINT pnl_category_norms_thresholds_ok
    CHECK (
      attention_of_norm_pct > 100
      AND critical_of_norm_pct > attention_of_norm_pct
    );

COMMENT ON COLUMN public.pnl_category_norms.attention_of_norm_pct IS 'Порог «внимание»: при факт/норма > (это значение)/100 жёлтый заканчивается';
COMMENT ON COLUMN public.pnl_category_norms.critical_of_norm_pct IS 'Порог «критично»: при факт/норма > (это значение)/100 — красный';
