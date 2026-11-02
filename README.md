# Telegram Bot Dashboard

Веб-панель для переписки с пользователями Telegram-бота.

## Архитектура

- `index.html` — интерфейс, который Render отдаёт с того же домена, что и API.
- `server.js` — Node.js + Express: принимает Telegram webhook, защищает панель и отправляет ответы.
- Neon PostgreSQL — хранит чаты и историю сообщений.

## Render

Web Service из этого репозитория: Node, Build Command `npm install`, Start Command `npm start`, Free instance (может засыпать после простоя).

Переменные окружения: `BOT_TOKEN`, `DATABASE_URL`, `ADMIN_API_KEY`, `WEBHOOK_SECRET`. Не публикуй реальные значения в GitHub.

## Вход

Открой HTTPS-адрес Render и введи `ADMIN_API_KEY`. Сервер выдаёт подписанную cookie с флагами HttpOnly, SameSite=Strict и Secure в production. Ключ не сохраняется в localStorage/sessionStorage и не отправляется при обычных запросах. Срок сессии — 7 дней.

Интерфейс и API работают на одном домене, поэтому GitHub Pages и CORS для панели больше не нужны. GitHub остаётся хранилищем исходного кода.

## Telegram

После входа панель просит сервер зарегистрировать webhook на публичном HTTPS-адресе Render. Чаты появляются после того, как пользователь написал боту или отправил `/start`.

Таблицы в Neon создаются автоматически. Существующая база не удаляется.
