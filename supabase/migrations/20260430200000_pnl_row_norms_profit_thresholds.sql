-- Пороги строк прибыли: доля факта от нормы (0–100), не «перерасход» >100.

ALTER TABLE public.pnl_row_norms
  DROP CONSTRAINT IF EXISTS pnl_row_norms_thresholds;

UPDATE public.pnl_row_norms
SET
  attention_of_norm_pct = 90,
  critical_of_norm_pct  = 75
WHERE attention_of_norm_pct > 100
   OR critical_of_norm_pct > 100;

ALTER TABLE public.pnl_row_norms
  ALTER COLUMN attention_of_norm_pct SET DEFAULT 90,
  ALTER COLUMN critical_of_norm_pct SET DEFAULT 75;

ALTER TABLE public.pnl_row_norms
  ADD CONSTRAINT pnl_row_norms_thresholds CHECK (
    attention_of_norm_pct > 0
    AND attention_of_norm_pct < 100
    AND critical_of_norm_pct > 0
    AND critical_of_norm_pct < 100
    AND attention_of_norm_pct > critical_of_norm_pct
  );

COMMENT ON TABLE public.pnl_row_norms IS
  'Нормы %% для маржи и чистой прибыли; пороги — %% доли нормы (факт/норма): зелёный ≥ нормы, жёлтый от «внимание» до 100%%, красный ниже «внимание»';
COMMENT ON COLUMN public.pnl_row_norms.attention_of_norm_pct IS
  'Нижняя граница жёлтого: при факт/норма ∈ [значение..100) — внимание';
COMMENT ON COLUMN public.pnl_row_norms.critical_of_norm_pct IS
  'Глубина недобора (меньше «внимание»); хуже отклонения — ниже этого %% нормы';
