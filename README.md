### Hexlet tests and linter status:

[![Actions Status](https://github.com/vaagnavanesyan/llm-developer-project-425/actions/workflows/hexlet-check.yml/badge.svg)](https://github.com/vaagnavanesyan/llm-developer-project-425/actions)

## Сервисный аккаунт ai-studio-sa

У сервисного аккаунта `ai-studio-sa` есть следующие роли: `ai.languageModels.user`, `ai.assistants.editor`, `ydb.editor`, `functions.functionInvoker`, `lockbox.payloadViewer`, `serverless.mcpGateways.invoker`.

На workflow `daily-escalation` ему выданы `serverless.workflows.executor` и `serverless.workflows.viewer` — без них запуск по расписанию падает (API делает GET перед запуском, поэтому viewer нужен даже для invoke).

## Секреты в Lockbox

Также созданы секреты в Lockbox:

- `ydb-endpoint`
- `ydb-database`
- `ai-studio-api-key` (значение ключа)
- `ai-studio-api-key-id` (идентификатор ключа)

## Ежедневная эскалация тикетов (workflow daily-escalation)

`src/workflow.yaml` (YaWL 0.1) раз в день в 9:00 по Москве находит открытые тикеты старше 24 часов, просит агента AI Studio составить сводку, переводит тикеты в `escalated` и отправляет дайджест оператору через функцию `email-sender`:

```
select_overdue (databaseQuery) → check_overdue (switch) ─ пусто → nothing_to_do
                                                       └ иначе → make_digest (aiStudioAgent)
                                                                 → mark_escalated (databaseQuery, UPDATE)
                                                                 → send_digest (httpCall → email-sender) → done
```

Деплой:

```bash
./deploy.sh email-sender
./deploy.sh workflow
```

Ручной запуск: `yc serverless workflow execution start daily-escalation`, результат — `yc serverless workflow execution get <id>`.

Что выяснилось на практике:

- `output` шага — шаблон, который должен дать JSON-объект; он дописывается в состояние workflow. Поэтому каждый шаг кладёт результат под свой ключ (`overdue`, `digest`, `escalated`, `sent`), иначе сырой `ResultSets` следующего запроса затрёт выборку.
- Точный список тикетов в письме собирается из выборки, а не из ответа модели: агент искажал UUID тикетов.
- Cron у workflow — 6 полей `sec min hour dom mon dow`, знак `?` не принимается: каждый день в 9:00 — `0 0 9 * * *`.
- Без роли `ydb.editor` шаг падает с `DATABASE_QUERY_CONNECTION_FAILED` (внутри — `PermissionDenied`), а не `STEP_PERMISSION_DENIED`. Поэтому этого кода нет в `retryPolicy`: повтор не лечит отказ по правам.
- `email-sender` открыта без аутентификации (`httpCall` не шлёт IAM-токен), поэтому адресат берётся только из её `OPERATOR_EMAIL`, а из тела запроса — лишь тема и текст.

### Poller по таймеру или workflow по расписанию

`email-poller` — императивный код в Cloud Function: IMAP, парсинг писем, история переписки, ретраи и логи пишем сами, всё укладывается в таймаут функции. Workflow — декларативная склейка готовых сервисов (БД → LLM → HTTP): ретраи задаются `retryPolicy`, каждый шаг виден отдельно в `execution get` и YC Logging. Первое подходит, когда много своей логики и нестандартных протоколов; второе — для бизнес-процесса из нескольких шагов над готовыми интеграциями.
