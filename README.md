# P&L — Управление расходами

Внутреннее MVP-приложение: импорт расходов из 1C/Excel → хранение в Supabase → P&L-сводка с drill-down.

## Быстрый старт

```bash
# 1. Установить зависимости
npm install

# 2. Создать .env.local (см. ниже)
cp .env.local.example .env.local

# 3. Запустить в режиме разработки
npm run dev
# → http://localhost:3000
```

## Переменные окружения

Файл `.env.local` (никогда не коммитить):

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

- `NEXT_PUBLIC_SUPABASE_URL` — URL проекта из Supabase Dashboard → Settings → API
- `SUPABASE_SERVICE_ROLE_KEY` — секретный ключ, **используется только на сервере** (API routes)

> ⚠️ `SUPABASE_SERVICE_ROLE_KEY` не должен попадать в клиентский код. Все запросы к Supabase идут через серверные API routes.

## Страницы

| URL | Описание |
|-----|---------|
| `/` | Главная — навигация |
| `/pnl` | P&L-сводка: расходы по категориям × месяцам, drill-down |
| `/expenses` | Таблица расходов: поиск, фильтры, ручное добавление, редактирование |
| `/expenses/import` | Импорт Excel: парсинг, preview, commit |

## Пользовательский сценарий

### 1. Импорт расходов из Excel

1. Открыть `/expenses/import`
2. Выбрать `.xlsx` файл из 1C
3. Нажать **«Проверить перед импортом»** — сравнение с текущими данными:
   - **Новые** — строки, которых нет в БД; для строк без категории выбрать категорию
   - **Конфликты** — строки с расхождениями; выбрать «Оставить текущее» или «Перезаписать»
   - **Без изменений** — не трогаются
4. Нажать **«Импортировать расходы»** — данные записываются
6. После commit автоматически запускается повторный preview: все строки должны показаться как «Без изменений»

### 2. Просмотр и редактирование расходов

1. Открыть `/expenses`
2. Поиск по номеру, контрагенту, комментарию — поле «Поиск» + Enter или кнопка «Найти»
3. Фильтр по категории и периоду — применяется сразу
4. Кнопка **«Добавить расход»** — ручное создание (московское время)
5. Кнопка **«Изменить»** в строке — редактирование расхода

### 3. P&L-сводка

1. Открыть `/pnl`
2. Выбрать год (по умолчанию — текущий)
3. Таблица: строки = категории, колонки = 12 месяцев, нули = «—»
4. **Drill-down:**
   - Клик по ячейке (категория × месяц) — расходы этой категории за этот месяц
   - Клик по названию категории — все расходы категории за год
   - Клик по строке «ИТОГО», ячейка месяца — все расходы за этот месяц
5. В панели drill-down — клик по расходу открывает `/expenses?q=<номер>`
6. Ссылка «Открыть в таблице расходов» — переход с предзаполненными фильтрами

## База данных

### Таблица `public.expenses`

| Поле | Тип | Описание |
|------|-----|---------|
| `id` | uuid | PK, gen_random_uuid() |
| `external_number` | text | Уникальный номер (МС00-000023 или MANUAL-{ts}) |
| `document_title` | text | Полный текст документа из 1C |
| `expense_date` | timestamptz | Дата расхода в UTC (московское время - 3ч) |
| `contractor` | text | Контрагент |
| `comment` | text | Комментарий / назначение |
| `amount` | numeric(14,2) | Сумма в рублях |
| `category` | text | Категория из справочника |
| `source` | text | `excel` или `manual` |
| `raw_row` | jsonb | Сырые данные строки из Excel |
| `created_at` | timestamptz | Время создания записи |
| `updated_at` | timestamptz | Время последнего обновления (trigger) |

### Миграция

```bash
# Применить через Supabase CLI
supabase link --project-ref <project-ref>
supabase db push

# Или применить вручную через SQL Editor в Supabase Dashboard:
# supabase/migrations/20260424120000_create_expenses.sql
```

## API

| Метод | URL | Описание |
|-------|-----|---------|
| GET | `/api/expenses` | Список расходов (q, category, dateFrom, dateTo, limit, offset) |
| POST | `/api/expenses` | Создать расход вручную |
| PATCH | `/api/expenses/[id]` | Обновить расход |
| POST | `/api/expenses/import/parse-preview` | Распарсить Excel без сохранения |
| POST | `/api/expenses/import/preview` | Excel + сравнение с БД |
| POST | `/api/expenses/import/commit` | Сохранить результат импорта |
| GET | `/api/pnl/expenses-summary` | Сводка по категориям × месяцам (year) |
| GET | `/api/pnl/expenses-drilldown` | Детализация (year, month, category) |

## Стек

- **Next.js 15** (App Router, TypeScript)
- **Supabase** (PostgreSQL, service role client)
- **Tailwind CSS v4**
- **xlsx** — парсинг Excel (server-only)

## Известные ограничения MVP

- RLS отключён (внутренний инструмент)
- Категории хранятся в коде (`src/lib/expenses/categories.ts`), не в БД
- `xlsx` имеет известные CVE (приемлемо для внутреннего использования)
- Timezone: даты из Excel интерпретируются как UTC+3 (Москва, без DST)
- Удаление расходов не реализовано
