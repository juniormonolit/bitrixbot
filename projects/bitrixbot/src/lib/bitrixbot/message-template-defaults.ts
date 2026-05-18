/** Дефолты по code — совпадают с seed в `20260508_1631_alerting_foundation_tables.sql`. */
export const MESSAGE_TEMPLATE_BODY_DEFAULTS: Record<string, string> = {
  missed_count_manager_default:
    "{message}\nМенеджер: {manager_name}\nТелефон: {phone}",
  missed_count_rop_default:
    "{message}\nМенеджер: {manager_name}\nТелефон: {phone}",
  missed_count_department_director_default:
    "{message}\nМенеджер: {manager_name}\nТелефон: {phone}",
  missed_count_company_director_default:
    "{message}\nМенеджер: {manager_name}\nТелефон: {phone}"
};
