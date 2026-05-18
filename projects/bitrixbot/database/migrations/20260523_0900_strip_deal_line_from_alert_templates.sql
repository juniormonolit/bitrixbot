-- Remove "Сделка: …deal_url…" line from stored templates (alert flow no longer enriches deals).

begin;

update message_templates
set body = regexp_replace(body, e'\r?\nСделка:\s*\{deal_url\}', '', 'gi')
where body ~* e'Сделка:\s*\{deal_url\}';

update alert_notification_rules
set message_template = regexp_replace(message_template, e'\r?\nСделка:\s*\{\{deal_url\}\}', '', 'gi')
where message_template ~* e'Сделка:\s*\{\{deal_url\}\}';

update alert_notification_rules
set message_template = regexp_replace(message_template, e'\r?\nСделка:\s*\{deal_url\}', '', 'gi')
where message_template ~* e'Сделка:\s*\{deal_url\}';

commit;
