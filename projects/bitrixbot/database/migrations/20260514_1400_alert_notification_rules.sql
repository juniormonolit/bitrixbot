-- Alert notification rules (constructor) + delivery link + recipient_role extension.

create table if not exists public.alert_notification_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  enabled boolean not null default true,
  sort_order int not null default 100,

  missed_count_threshold int null,
  no_callback_minutes int null,
  condition_operator text not null default 'OR'
    check (condition_operator in ('AND', 'OR')),

  recipients jsonb not null default '[]'::jsonb,
  message_template text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at_alert_notification_rules on public.alert_notification_rules;
create trigger set_updated_at_alert_notification_rules
before update on public.alert_notification_rules
for each row execute function public.set_updated_at();

create index if not exists alert_notification_rules_enabled_sort_idx
  on public.alert_notification_rules (enabled, sort_order asc);

alter table if exists public.notification_deliveries
  add column if not exists alert_rule_id uuid null references public.alert_notification_rules(id) on delete set null;

-- Allow manual recipients from rule constructor
alter table public.notification_deliveries drop constraint if exists notification_deliveries_recipient_role_check;
alter table public.notification_deliveries
  add constraint notification_deliveries_recipient_role_check
  check (
    recipient_role in (
      'manager',
      'rop',
      'department_director',
      'company_director',
      'manual'
    )
  );

create unique index if not exists notification_deliveries_alert_rule_recipient_dedupe_idx
  on public.notification_deliveries (case_id, alert_rule_id, recipient_bitrix_user_id)
  where delivery_status in ('pending', 'sent') and alert_rule_id is not null;

create index if not exists notification_deliveries_alert_rule_id_idx
  on public.notification_deliveries (alert_rule_id);

-- Seed default rules (stable ids for documentation / FK references in notes)
insert into public.alert_notification_rules (
  id, name, enabled, sort_order,
  missed_count_threshold, no_callback_minutes, condition_operator,
  recipients, message_template
)
values
  (
    'a1000000-0000-4000-8000-000000000001',
    'Первый пропущенный — менеджеру',
    true,
    10,
    1,
    null,
    'OR',
    '[{"type":"responsible_manager"}]'::jsonb,
    $tpl1$
{{message}}

Менеджер: {{manager_name}}
Телефон: {{phone}}
Сделка: {{deal_url}}
Пропущенных подряд: {{missed_count}}
Время без исходящего: {{minutes_without_callback}} мин.
$tpl1$
  ),
  (
    'a1000000-0000-4000-8000-000000000002',
    '2 пропущенных или 15 минут — РОПу',
    true,
    20,
    2,
    15,
    'OR',
    '[{"type":"rop"}]'::jsonb,
    $tpl2$
{{message}}

Менеджер: {{manager_name}}
Телефон: {{phone}}
Сделка: {{deal_url}}
Пропущенных подряд: {{missed_count}}
Время без исходящего: {{minutes_without_callback}} мин.
$tpl2$
  ),
  (
    'a1000000-0000-4000-8000-000000000003',
    '3 пропущенных или 30 минут — директору',
    true,
    30,
    3,
    30,
    'OR',
    '[{"type":"director"}]'::jsonb,
    $tpl3$
{{message}}

Менеджер: {{manager_name}}
Телефон: {{phone}}
Сделка: {{deal_url}}
Пропущенных подряд: {{missed_count}}
Время без исходящего: {{minutes_without_callback}} мин.
$tpl3$
  )
on conflict (id) do nothing;

alter table if exists public.missed_call_cases
  add column if not exists last_triggered_alert_rule_id uuid null references public.alert_notification_rules(id) on delete set null;

create index if not exists missed_call_cases_last_triggered_alert_rule_idx
  on public.missed_call_cases (last_triggered_alert_rule_id);
