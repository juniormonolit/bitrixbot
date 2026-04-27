-- Migration: create_pnl_structure
-- Иерархическая структура строк P&L

create table if not exists public.pnl_structure (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  type       text        not null check (type in ('category', 'group', 'formula')),
  parent_id  uuid        null references public.pnl_structure(id) on delete cascade,
  category   text        null,    -- для type='category': имя категории в expenses
  formula    text        null,    -- для type='formula' (зарезервировано)
  sort_order integer     not null default 1000,
  level      integer     not null default 0,
  is_active  boolean     not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_pnl_structure_parent
  on public.pnl_structure (parent_id, sort_order);

create or replace trigger trg_pnl_structure_updated_at
  before update on public.pnl_structure
  for each row
  execute function public.set_updated_at();

comment on table  public.pnl_structure           is 'Иерархическая структура P&L (группы и категории расходов)';
comment on column public.pnl_structure.type      is 'category | group | formula';
comment on column public.pnl_structure.category  is 'Для type=category: значение поля category в таблице expenses';
comment on column public.pnl_structure.level     is 'Уровень вложенности (0 = корень)';

-- ── Seed: минимальная структура ───────────────────────────────────────────────
-- Используем фиксированные UUID чтобы прописать parent_id в том же скрипте.

do $$
declare
  id_total      uuid := 'b0000000-0000-0000-0000-000000000001';
  id_commercial uuid := 'b0000000-0000-0000-0000-000000000002';
  id_admin      uuid := 'b0000000-0000-0000-0000-000000000003';
begin
  -- Корень
  insert into public.pnl_structure (id, name, type, parent_id, sort_order, level)
  values (id_total, 'Расходы всего', 'group', null, 10, 0);

  -- Группы второго уровня
  insert into public.pnl_structure (id, name, type, parent_id, sort_order, level)
  values
    (id_commercial, 'Коммерческие расходы',     'group', id_total, 10, 1),
    (id_admin,      'Административные расходы', 'group', id_total, 20, 1);

  -- Коммерческие → категории
  insert into public.pnl_structure (name, type, parent_id, category, sort_order, level)
  values
    ('ЗП',         'category', id_commercial, 'ЗП',         10, 2),
    ('Маркетинг',  'category', id_commercial, 'Маркетинг',  20, 2),
    ('Колл-центр', 'category', id_commercial, 'Колл-центр', 30, 2);

  -- Административные → категории
  insert into public.pnl_structure (name, type, parent_id, category, sort_order, level)
  values
    ('Аренда офиса', 'category', id_admin, 'Аренда офиса', 10, 2),
    ('Бухгалтерия',  'category', id_admin, 'Бухгалтерия',  20, 2),
    ('IT',           'category', id_admin, 'IT',           30, 2);
end $$;
