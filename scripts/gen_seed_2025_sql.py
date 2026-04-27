"""Generate supabase seed SQL for 2025 — run: py -3 scripts/gen_seed_2025_sql.py"""
from __future__ import annotations

# December +3 revenue / +1 GM to match stated ИТОГО in source table
REV = [
    10_612_147,
    18_458_066,
    23_628_692,
    41_514_020,
    38_854_791,
    41_830_103,
    52_761_205,
    55_017_105,
    50_151_486,
    55_906_835,
    46_775_264,
    39_551_594,
]
GM = [
    1_361_398,
    2_459_248,
    2_864_519,
    4_955_435,
    4_083_563,
    4_714_268,
    5_695_566,
    6_136_174,
    5_488_680,
    5_990_904,
    5_021_497,
    4_061_726,
]
PL = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 308_608]  # корректировка в декабре

# Латиница в external_number — без сюрпризов в интеграциях
CAT_SLUG: dict[str, str] = {
    "ЗП МЕН": "zp-men",
    "ЗП РОП": "zp-rop",
    "ЗП ЛОГ": "zp-log",
    "Маркетинг": "marketing",
    "Аренда": "rent",
    "Склад": "sklad",
    "ХОЗ": "hoz",
    "Найм": "naim",
    "Адаптация и мотивация": "adapt",
    "Банк": "bank",
    "АЙТИ": "it",
    "Прочие расходы": "misc",
    "Юр услуги и без": "legal",
    "Курьеры": "courier",
    "Налог за ЗП": "tax-zp",
    "Налоги за безнал": "tax-cashless",
}

CATS: dict[str, list[int]] = {
    "ЗП МЕН": [885_000, 1_105_020, 990_000, 1_304_525, 1_222_000, 1_311_150, 1_427_000, 1_442_500, 1_305_150, 1_238_931, 1_248_600, 1_054_250],
    "ЗП РОП": [232_107, 273_500, 328_500, 488_500, 483_846, 423_500, 443_500, 426_650, 523_500, 603_500, 528_500, 545_250],
    "ЗП ЛОГ": [470_000, 507_400, 475_892, 654_846, 591_252, 700_346, 702_786, 605_345, 665_563, 612_059, 762_538, 859_146],
    "Маркетинг": [135_000, 280_000, 479_273, 443_000, 230_000, 371_956, 282_000, 467_000, 169_000, 293_100, 447_200, 384_800],
    "Аренда": [160_500, 217_650, 210_500, 212_600, 210_500, 210_500, 210_500, 210_500, 210_500, 210_500, 377_000, 308_642],
    "Склад": [0, 0, 0, 0, 0, 5_000, 0, 0, 1_750, 0, 0, 0],
    "ХОЗ": [15_925, 2_050, 59_205, 24_760, 31_078, 24_075, 20_350, 16_920, 45_197, 5_760, 38_764, 58_843],
    "Найм": [80_000, 87_400, 115_968, 119_982, 149_962, 98_382, 120_000, 120_992, 121_197, 119_708, 120_020, 95_411],
    "Адаптация и мотивация": [50_500, 163_200, 90_000, 149_035, 52_500, 48_000, 82_897, 44_105, 46_580, 44_592, 47_000, 51_470],
    "Банк": [0, 0, 0, 0, 15_810, 5_168, 5_240, 875, 78, 2_310, 633, 880],
    "АЙТИ": [29_714, 35_714, 36_714, 42_714, 35_714, 30_580, 31_580, 30_000, 59_492, 37_580, 50_480, 44_580],
    "Прочие расходы": [68_796, 458_717, 46_190, 59_781, 47_000, 23_800, 33_675, 40_050, 115_542, 51_760, 398_324, 338_642],
    "Юр услуги и без": [0, 0, 1_010, 26_460, 0, 0, 0, 0, 850, 0, 780, 0],
    "Курьеры": [0, 0, 2_390, 22_500, 12_000, 5_500, 1_452, 2_515, 20_240, 18_276, 20_000, 0],
    "Налог за ЗП": [274_817, 341_843, 320_058, 434_702, 399_930, 413_020, 444_189, 422_335, 425_918, 419_006, 433_065, 416_884],
    "Налоги за безнал": [79_591, 138_435, 177_215, 311_355, 291_411, 313_726, 395_709, 412_628, 376_136, 419_301, 350_814, 296_637],
}


def main() -> None:
    lines: list[str] = [
        "-- Seed 2025: выручка, маржа, прибыль прошлых лет (корректировка) + синтетические расходы по месяцам",
        "-- Один агрегат на категорию × месяц; external_number уникален.",
        "",
    ]

    mv: list[str] = []
    for m in range(12):
        mv.append(
            f"(2025, {m + 1}, 'revenue', {REV[m]:.2f}),"
        )
        mv.append(
            f"(2025, {m + 1}, 'gross_margin', {GM[m]:.2f}),"
        )
        mv.append(
            f"(2025, {m + 1}, 'profit_loss_prev_years', {PL[m]:.2f}),"
        )
    lines.append("insert into public.pnl_monthly_values (year, month, metric, amount)")
    lines.append("values")
    lines.append("\n".join(mv).rstrip(","))
    lines.append(
        "on conflict (year, month, metric) do update set amount = excluded.amount, updated_at = now();"
    )
    lines.append("")

    ex: list[str] = []
    for cat, arr in CATS.items():
        slug = CAT_SLUG[cat]
        for mi, amt in enumerate(arr):
            if amt <= 0:
                continue
            month = mi + 1
            ext = f"SYN-2025-{slug}-{month:02d}"
            dt = f"2025-{month:02d}-15T12:00:00.000Z"
            ex.append(
                "  ("
                f"'{ext}', "
                "'Синтетика 2025 (агрегат за месяц)', "
                f"'{dt}'::timestamptz, "
                "null, "
                f"'{cat} — {month:02d}/2025', "
                f"{amt:.2f}, "
                f"'{cat}', "
                "'manual'"
                "),"
            )

    lines.append("insert into public.expenses (external_number, document_title, expense_date, contractor, comment, amount, category, source)")
    lines.append("values")
    lines.extend(ex)
    lines[-1] = lines[-1].rstrip(",")
    lines.append("on conflict (external_number) do update set")
    lines.append("  document_title = excluded.document_title,")
    lines.append("  expense_date   = excluded.expense_date,")
    lines.append("  contractor     = excluded.contractor,")
    lines.append("  comment        = excluded.comment,")
    lines.append("  amount         = excluded.amount,")
    lines.append("  category       = excluded.category,")
    lines.append("  source         = excluded.source,")
    lines.append("  deleted_at     = null,")
    lines.append("  deleted_reason = null,")
    lines.append("  updated_at     = now();")
    lines.append("")

    out = "\n".join(lines)
    import os

    root = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
    dest = os.path.join(root, "supabase", "migrations", "20260428120000_seed_2025_synthetic_pnl.sql")
    with open(dest, "w", encoding="utf-8") as f:
        f.write(out)
    print("Wrote", dest)
    print("revenue sum", sum(REV), "gm sum", sum(GM), "pl sum", sum(PL))


if __name__ == "__main__":
    main()
