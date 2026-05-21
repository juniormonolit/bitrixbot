# LOGIN сотрудников (mlt.managers.list)

Стандартный `user.get` **не отдаёт** поле `LOGIN` на портале (см. `npm run probe:user-login`).

## Решение (используется в production)

Входящий вебхук с методом **`mlt.managers.list`** (`MANAGER_BITRIX_REST_BASE_URL`). Ответ: `result[]` с `ID` и `LOGIN`.

```env
BITRIX_USER_LOGINS_REST_METHOD=mlt.managers.list
MANAGER_BITRIX_REST_BASE_URL=https://portal/rest/USER/WEBHOOK/
# или полный URL: .../mlt.managers.list.json
```

Синхронизация: cron `org-structure-refresh`, кнопка «Синхронизировать сейчас» в админке (вкладка «Структура»).

## Альтернатива: свой PHP-метод bitrixbot.user.logins.list

На **коробочном** Bitrix24 можно добавить REST из `bitrix-portal/rest/` (если нет `mlt.managers.list`).

## Установка на портале Bitrix

1. Скопировать `bitrix-portal/rest/BitrixbotUserLoginRest.php` в  
   `/local/php_interface/bitrixbot/BitrixbotUserLoginRest.php` на сервере портала.

2. В `/local/php_interface/init.php` добавить регистрацию (см. `bitrix-portal/rest/init.php.example`).

3. Очистить кеш Bitrix (админка → производительность или `php -f clear_cache.php`).

4. В настройках **локального приложения** или **входящего вебхука**, которым пользуется bitrixbot, выдать право на scope **`bitrixbot`** (или метод в глобальном scope, если переопределите).

5. Проверка в браузере / curl:

   ```text
   POST {BITRIX_REST_BASE_URL}bitrixbot.user.logins.list.json
   Body: { "start": 0 }
   Header: x-bitrix-application-token: ...
   ```

   Ожидаемый фрагмент ответа:

   ```json
   {
     "result": [{ "ID": "2098", "LOGIN": "junior", "NAME": "...", "LAST_NAME": "..." }],
     "next": 50,
     "total": 123
   }
   ```

6. В `.env` bitrixbot:

   ```env
   BITRIX_USER_LOGINS_REST_METHOD=bitrixbot.user.logins.list
   ```

7. Миграция Supabase: `database/migrations/20260526_1000_employees_bitrix_login.sql`

8. Запустить sync: ручное «Обновить структуру» или дождаться cron — в `employees` заполнится `bitrix_login`.

## Проверка из bitrixbot

```bash
npm run probe:user-login -- --id 2098 --login junior
```

После установки PHP-метода добавьте в env `BITRIX_USER_LOGINS_REST_METHOD` и вызовите:

```bash
curl ".../api/debug/alerting/probe-user-login?secret=...&bitrixUserId=2098"
```

В ответе появится блок `customRestMethod` с `loginValue: "junior"`.

## Почему не email / XML_ID

По требованию проекта сопоставление идёт по **логину входа в портал**, а не по почте. Email в REST есть, но не совпадает с семантикой LOGIN.

## Альтернатива без PHP

Заполнить пользовательское поле `UF_*` или `XML_ID` значением логина скриптом на стороне Bitrix и читать его стандартным `user.get` — дублирование данных; кастомный REST предпочтительнее.
