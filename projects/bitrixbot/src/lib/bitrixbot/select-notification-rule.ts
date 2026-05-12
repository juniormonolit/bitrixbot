export type NotificationRuleRow = {
  id: string;
  is_active: boolean;
  sort_order: number;
  trigger_type: "missed_count" | "no_callback_after" | string;
  missed_count_from: number | null;
  missed_count_to: number | null;
  delay_minutes: number | null;
  recipient_roles: unknown;
  stop_processing: boolean;
};

export type NotificationRuleContext = {
  missedCount: number;
  minutesSinceLastMissed: number | null;
  hasCallbackAfterMissed: boolean;
};

function matchesMissedCount(rule: NotificationRuleRow, missedCount: number): boolean {
  if (rule.missed_count_from !== null && missedCount < rule.missed_count_from) return false;
  if (rule.missed_count_to !== null && missedCount > rule.missed_count_to) return false;
  return true;
}

function matchesNoCallbackAfter(rule: NotificationRuleRow, context: NotificationRuleContext): boolean {
  if (rule.delay_minutes === null) return false;
  if (context.minutesSinceLastMissed === null) return false;
  if (context.hasCallbackAfterMissed) return false;
  return context.minutesSinceLastMissed >= rule.delay_minutes;
}

export function selectNotificationRule(
  rules: NotificationRuleRow[],
  context: NotificationRuleContext
): NotificationRuleRow | null {
  const active = rules.filter((r) => r.is_active);

  const applicable = active.filter((r) => {
    if (r.trigger_type === "missed_count") {
      return matchesMissedCount(r, context.missedCount);
    }
    if (r.trigger_type === "no_callback_after") {
      return matchesNoCallbackAfter(r, context);
    }
    return false;
  });

  if (applicable.length === 0) return null;
  return applicable.reduce((best, cur) => (cur.sort_order >= best.sort_order ? cur : best));
}

