# Alerting runtime foundation (missed calls)

## Что уже есть

- В Supabase есть сырой storage входящих Bitrix webhook событий: `public.bitrix_webhook_events`.
- Оргструктура синхронизируется в локальные таблицы: `public.departments`, `public.employees`.
- Для alerting слоя добавлены foundation таблицы:
  - `public.org_resolved_hierarchy`
  - `public.org_role_overrides`
  - `public.notification_rules`
  - `public.message_templates` (расширена)
  - `public.missed_call_cases`
  - `public.notification_deliveries`

## Как работает hierarchy resolver

Файл: `src/lib/bitrixbot/resolve-org-hierarchy.ts`

- Для каждого сотрудника берется базовый отдел из `employees.department_id` (uuid).
- Цепочка отделов строится вверх через `departments.parent_bitrix_department_id -> departments.bitrix_department_id`.
- Защита от циклов: по `bitrix_department_id`.
- Роли определяются в приоритете:
  - **rop**: `employees.rop_bitrix_user_id` → override по department → override global → null
  - **department_director**: `employees.department_director_bitrix_user_id` → override по цепочке departments → override global → null
  - **company_director**: `employees.company_director_bitrix_user_id` → override global → null
- Результат upsert'ится в `public.org_resolved_hierarchy` по `manager_bitrix_user_id`.
- `resolved_path` хранит цепочку отделов и источники ролей для дебага.

## Как выбирается rule

Файл: `src/lib/bitrixbot/select-notification-rule.ts`

- Берутся только `is_active = true`.
- Правила фильтруются по `trigger_type`:
  - `missed_count`: диапазон `missed_count_from/to`
  - `no_callback_after`: `delay_minutes` + проверка `hasCallbackAfterMissed = false`
- Если подходит несколько — выбирается последнее (максимальный `sort_order`).

## Как рендерятся сообщения

Файл: `src/lib/bitrixbot/render-message-template.ts`

- Подстановка переменных вида `{manager_name}`.
- Отсутствующие значения → пустая строка.
- После рендера схлопываются 3+ пустые строки и делается trim.

## Как формируются pending deliveries

Файл: `src/lib/bitrixbot/prepare-notifications-for-missed-call-case.ts`

1. Загружается `missed_call_cases` по `caseId`.
2. Загружается `org_resolved_hierarchy` по `case.manager_bitrix_user_id`.
3. Загружаются активные `notification_rules`, выбирается rule через selector.
4. Парсятся `recipient_roles` из jsonb (валидные роли: manager/rop/department_director/company_director).
5. Для каждой роли:
   - выбирается активный template (`channel=bitrix_chat`, `target_role=...`)
   - рендерится message_text
   - создается `notification_deliveries` со статусом `pending`
6. Антидубль: не создается delivery, если уже есть delivery для того же `(case_id, rule_id, recipient_role, recipient_bitrix_user_id)` со статусом `pending` или `sent`.
7. Обновляется `missed_call_cases.last_triggered_rule_id/last_triggered_at`.

## Что пока не сделано (следующий шаг)

- Автоматическое создание/обновление `missed_call_cases` из `call_events`.
- Реальная отправка сообщений в Bitrix и перевод `delivery_status` в `sent/failed`.
- Планировщик / cron.

## Этап 3: call_events -> missed_call_cases (batch, без cron)

- Таблица состояния обработки: `public.call_event_case_processing`
  - 1 запись на 1 `call_events.id`
  - статусы: pending/processed/skipped/failed
- Логика отбора "интересных" событий: только `call_direction=inbound` и `status=missed`.
- Стратегия matching existing case (временно):
  - `phone_normalized` + `manager_bitrix_user_id` + `status=open` + окно 24 часа
  - если удалось достать `deal_id`, сначала пробуем матчить по `deal_id`, иначе fallback без deal_id
- После create/update case вызывается `prepareNotificationsForMissedCallCase(caseId)`
  - ошибки подготовки deliveries не откатывают кейс

### Ручной запуск (debug endpoints)

Оба endpoint защищены `DEBUG_SECRET` (header `x-debug-secret` или query `?secret=`):

- `POST /api/debug/alerting/rebuild-hierarchy`
- `POST /api/debug/alerting/process-missed-calls` с body `{ "limit": 100 }`

## Этап 4: callback resolution + no_callback_after (без новых missed)

### Callback — определение v1

Callback считается найденным, если есть `call_events`:

- `call_direction = outbound`
- `status = success`
- `phone_normalized = case.phone_normalized`
- `occurred_at >= case.last_missed_at`

Если в кейсе задан `manager_bitrix_user_id`, сначала пытаемся матчить по **phone+manager**,
если не найдено — fallback до **phone_only**.

### No-callback-after (SLA) — дедуп

Таблица: `public.case_rule_executions`

- 1 запись на `(case_id, rule_id)`, уникально
- защищает от повторной эскалации одного и того же SLA-правила по одному кейсу

### Batch processors (ручной запуск)

Все endpoint защищены `DEBUG_SECRET` (header `x-debug-secret` или query `?secret=`):

- `POST /api/debug/alerting/process-callback-resolution` с body `{ "limit": 100 }`
- `POST /api/debug/alerting/process-no-callback-escalations` с body `{ "limit": 100 }`

## Этап 5–6: Консоль + sender (guardrails)

### Глобальные guardrails (runtime invariant)

Истина хранится в БД: `public.alerting_settings` (`settings_key='global'`).

Sender **обязан** перед отправкой проверять:

- `sending_enabled` (kill switch)
- `dry_run_mode` (safe mode)
- `send_only_to_mirror` (safe live subset: отправка только дублей)
- `mirror_enabled` / `mirror_bitrix_user_id` (дублирование)

Реальная отправка основным получателям возможна только если одновременно:

- `sending_enabled=true`
- `dry_run_mode=false`
- `send_only_to_mirror=false`

При `send_only_to_mirror=true` в **живом** режиме отправки (`sending_enabled=true`, `dry_run_mode=false`, summary `mode=mirror_only_test`):

- основному получателю сообщение не отправляется;
- `notification_deliveries` получает `delivery_status='skipped'` и пояснение в `error_message`, без `sent_at` / `provider_message_id`;
- зеркальная доставка в `notification_delivery_mirrors` отправляется на `mirror_bitrix_user_id`;
- если зеркальная отправка завершилась ошибкой, основная доставка всё равно остаётся `skipped` — основной адресат в mirror-only не должен получить сообщение;
- так очередь `pending` не забивается тестовыми доставками, которые уже обработаны только через дубль.

### Mirror-to-me (дубли)

Дубли пишутся в отдельный журнал: `public.notification_delivery_mirrors`.
Ошибка дубля **не** ломает основную доставку.

### Ручной запуск sender

- `/admin/alerting` → action “Отправить pending deliveries”
- `POST /api/debug/alerting/process-pending-deliveries` с body `{ "limit": 50 }`

### Полный цикл (иерархия → missed → callback → no-callback → sender)

Общая функция: `runAlertingFullCycle(limit)` в `src/lib/bitrixbot/run-alerting-full-cycle.ts`.

- Ручная консоль: действие **«Запустить полный цикл»** (тот же pipeline).
- `POST /api/debug/alerting/run-full-cycle` с body `{ "limit": 100 }` — авторизация как у остальных debug endpoints (`x-debug-secret` или `?secret=`).
- `POST /api/internal/alerting/run-full-cycle` — тот же pipeline для внешнего cron; защита тем же секретом (предпочтительно заголовок `x-debug-secret`).

## Как включить на постоянку

1. Проверить настройки в `/admin/alerting` (kill switch, dry run, mirror-only, mirror user).
2. Сначала включить **mirror-only test** (`send_only_to_mirror=true` при live-отправке) и убедиться, что сообщения приходят только mirror-пользователю, а primary — `skipped`.
3. После успешного теста для боевого режима выставить:

   - `send_only_to_mirror=false`
   - `sending_enabled=true`
   - `dry_run_mode=false`
   - при необходимости `mirror_enabled=true` (дубли в проде).

4. Настроить cron на сервере, например раз в минуту:

```bash
curl -X POST "https://bitrixbot.mltvibes.ru/api/internal/alerting/run-full-cycle" \
  -H "x-debug-secret: $DEBUG_SECRET" \
  -H "content-type: application/json" \
  -d '{"limit":100}'
```

Подставьте свой хост вместо примера. **Не включайте боевой режим** (`send_only_to_mirror=false` при реальной отправке основным) до успешного mirror-only теста.

