# Telegram Bot Dashboard

Панель переписки с Telegram-ботом: список чатов, история входящих/исходящих сообщений и отправка ответов.

## Архитектура

- Frontend: `index.html` (можно открыть через GitHub Pages).
- Backend: Node.js + Express (`server.js`), размещается на Render.
- База данных: PostgreSQL, например Neon.
- Токен Telegram хранится только в переменных окружения Render. Не добавляйте токены и пароли в GitHub.

## Render

Создайте Web Service из этого репозитория:
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Instance: Free (для тестирования; сервис может засыпать после простоя)

Добавьте Environment Variables:
- `BOT_TOKEN` — токен бота от BotFather.
- `DATABASE_URL` — строка подключения PostgreSQL из Neon.
- `ADMIN_API_KEY` — длинный случайный секрет для доступа к панели.
- `WEBHOOK_SECRET` — отдельный случайный секрет для проверки Telegram webhook.
- `ALLOWED_ORIGIN` — адрес GitHub Pages, например `https://voolder3-dev.github.io`. Для временной отладки допустимо `*`, но лучше ограничить домен.

## База данных

Создайте PostgreSQL project в Neon и скопируйте connection string в `DATABASE_URL`. Таблицы создаются автоматически при старте сервера.

## Панель

Откройте GitHub Pages сайта, укажите:
1. HTTPS-адрес Render Web Service.
2. Значение `ADMIN_API_KEY`.

Ключ доступа хранится только в sessionStorage текущей вкладки и не записывается в репозиторий.

## Подключение Telegram webhook

После успешного деплоя и подключения панели можно зарегистрировать webhook запросом:
`POST /api/webhook/register` с заголовком `X-Admin-Key: <ADMIN_API_KEY>` и JSON-телом `{"public_url":"https://YOUR-SERVICE.onrender.com"}`.

Панель будет показывать только чаты, в которых пользователь действительно написал боту. Telegram не сообщает боту о простом открытии профиля.

## Безопасность

- Никогда не публикуйте `BOT_TOKEN`, `DATABASE_URL`, `ADMIN_API_KEY` или `WEBHOOK_SECRET`.
- Если токен бота когда-либо раскрывался, отзовите его через BotFather и создайте новый.
- Входящие сообщения сохраняются в PostgreSQL. Не используйте панель для хранения чувствительных данных.
