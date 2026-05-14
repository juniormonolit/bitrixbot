-- First missed rule: require grace window (manager can callback) AND missed_count ≥ 1.
-- Escalation rules keep OR logic from seed (see migration 20260514).

update public.alert_notification_rules
set
  condition_operator = 'AND',
  no_callback_minutes = 10,
  updated_at = now()
where id = 'a1000000-0000-4000-8000-000000000001';
