-- Migration: create_expense_categories
-- Справочник категорий расходов

create table if not exists public.expense_categories (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null unique,
  sort_order  integer     not null default 1000,
  is_active   boolean     not null default true,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Reuse the set_updated_at function already defined in expenses migration
create or replace trigger trg_expense_categories_updated_at
  before update on public.expense_categories
  for each row
  execute function public.set_updated_at();

-- Seed: текущие категории из EXPENSE_CATEGORIES, шаг sort_order = 10
insert into public.expense_categories (name, sort_order) values
  ('ЗП',                          10),
  ('ОПРЫ',                        20),
  ('Логисты',                     30),
  ('Маркетинг',                   40),
  ('Колл-центр',                  50),
  ('Аренда офиса',                60),
  ('Склад',                       70),
  ('Бухгалтерия',                 80),
  ('ЖБИ',                         90),
  ('Найм',                       100),
  ('Адаптация и мотивация',      110),
  ('Банк',                       120),
  ('IT',                         130),
  ('Прочие расходы',             140),
  ('Юр.услуги и безопасность',   150),
  ('Курьеры',                    160),
  ('Разработка IT',              170)
on conflict (name) do nothing;

comment on table  public.expense_categories              is 'Справочник категорий расходов';
comment on column public.expense_categories.sort_order  is 'Порядок сортировки в P&L и выпадающих списках';
comment on column public.expense_categories.is_active   is 'false — категория скрыта из UI, но данные не теряются';
