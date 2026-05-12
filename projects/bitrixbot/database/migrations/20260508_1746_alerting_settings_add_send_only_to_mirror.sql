-- Add safe live testing flag to global alerting settings payload.

update public.alerting_settings
set settings_payload = settings_payload || '{"send_only_to_mirror": false}'::jsonb,
    updated_at = now()
where settings_key = 'global'
  and not (settings_payload ? 'send_only_to_mirror');

