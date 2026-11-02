const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// Разрешаем браузерные запросы только с явно указанных адресов панели.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map(value => value.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
  } else if (origin) {
    return res.status(403).json({ ok: false, error: "Этот адрес сайта не разрешён сервером. Проверь ALLOWED_ORIGIN." });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "32kb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!BOT_TOKEN || !DATABASE_URL || !ADMIN_API_KEY || !WEBHOOK_SECRET || allowedOrigins.length === 0) {
  console.error("Missing required environment variables: BOT_TOKEN, DATABASE_URL, ADMIN_API_KEY, WEBHOOK_SECRET, ALLOWED_ORIGIN");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAdmin(req, res, next) {
  const supplied = req.get("X-Admin-Key") || "";
  if (!safeEqual(supplied, ADMIN_API_KEY)) {
    return res.status(401).json({ ok: false, error: "Неверный ключ доступа. Проверь ADMIN_API_KEY на своём Render." });
  }
  next();
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    const error = new Error(data.description || "Ошибка Telegram Bot API.");
    error.status = response.status || 502;
    throw error;
  }
  return data.result;
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id BIGINT PRIMARY KEY,
      chat_type TEXT NOT NULL DEFAULT 'private',
      title TEXT,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      last_message_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
      telegram_message_id BIGINT,
      direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
      text TEXT NOT NULL DEFAULT '',
      sender_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS messages_chat_created_idx
      ON messages(chat_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS messages_telegram_unique_idx
      ON messages(chat_id, telegram_message_id, direction)
      WHERE telegram_message_id IS NOT NULL;
  `);
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "telegram-dashboard-api" }));
app.get("/", (_req, res) => res.redirect("https://voolder3-dev.github.io/tg_bot_web/"));
app.get("/api/session", requireAdmin, (_req, res) => res.json({ ok: true }));

app.post("/telegram/webhook", async (req, res) => {
  if (!safeEqual(req.get("X-Telegram-Bot-Api-Secret-Token") || "", WEBHOOK_SECRET)) {
    return res.sendStatus(401);
  }

  try {
    const update = req.body || {};
    const message = update.message || update.edited_message;
    if (!message || !message.chat) return res.sendStatus(200);

    const chat = message.chat;
    const from = message.from || {};
    const textValue = typeof message.text === "string"
      ? message.text
      : (message.caption || "[Сообщение без текста]");

    await pool.query(
      `INSERT INTO chats (chat_id, chat_type, title, username, first_name, last_name, last_message_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE(to_timestamp($7), NOW()))
       ON CONFLICT (chat_id) DO UPDATE SET
         chat_type = EXCLUDED.chat_type,
         title = COALESCE(EXCLUDED.title, chats.title),
         username = COALESCE(EXCLUDED.username, chats.username),
         first_name = COALESCE(EXCLUDED.first_name, chats.first_name),
         last_name = COALESCE(EXCLUDED.last_name, chats.last_name),
         last_message_at = GREATEST(COALESCE(chats.last_message_at, EXCLUDED.last_message_at), EXCLUDED.last_message_at)`,
      [
        String(chat.id), chat.type || "private", chat.title || null,
        chat.username || from.username || null, from.first_name || null,
        from.last_name || null, Number(message.date) || Math.floor(Date.now() / 1000)
      ]
    );

    await pool.query(
      `INSERT INTO messages (chat_id, telegram_message_id, direction, text, sender_name, created_at)
       VALUES ($1, $2, 'incoming', $3, $4, to_timestamp($5))
       ON CONFLICT DO NOTHING`,
      [
        String(chat.id), message.message_id || null, String(textValue).slice(0, 4096),
        [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || null,
        Number(message.date) || Math.floor(Date.now() / 1000)
      ]
    );

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook processing failed:", error.message);
    res.sendStatus(500);
  }
});

app.get("/api/chats", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.chat_id::text AS chat_id, c.chat_type, c.title, c.username,
              c.first_name, c.last_name, c.last_message_at,
              m.text AS last_message
       FROM chats c
       LEFT JOIN LATERAL (
         SELECT text FROM messages WHERE chat_id = c.chat_id
         ORDER BY created_at DESC, id DESC LIMIT 1
       ) m ON TRUE
       ORDER BY c.last_message_at DESC NULLS LAST`
    );
    res.json({ ok: true, chats: result.rows });
  } catch (error) {
    console.error("Chats query failed:", error.message);
    res.status(500).json({ ok: false, error: "Не удалось загрузить список чатов." });
  }
});

app.get("/api/chats/:chatId/messages", requireAdmin, async (req, res) => {
  const chatId = req.params.chatId;
  if (!/^-?\d+$/.test(chatId)) {
    return res.status(400).json({ ok: false, error: "Некорректный Chat ID." });
  }
  try {
    const result = await pool.query(
      `SELECT id, telegram_message_id, direction, text, sender_name, created_at
       FROM messages WHERE chat_id = $1
       ORDER BY created_at ASC, id ASC LIMIT 500`,
      [chatId]
    );
    res.json({ ok: true, messages: result.rows });
  } catch (error) {
    console.error("Messages query failed:", error.message);
    res.status(500).json({ ok: false, error: "Не удалось загрузить сообщения." });
  }
});

app.delete("/api/chats/:chatId/messages", requireAdmin, async (req, res) => {
  const chatId = req.params.chatId;
  if (!/^-?\d+$/.test(chatId)) {
    return res.status(400).json({ ok: false, error: "Некорректный Chat ID." });
  }
  try {
    const result = await pool.query("DELETE FROM messages WHERE chat_id = $1", [chatId]);
    await pool.query("UPDATE chats SET last_message_at = NULL WHERE chat_id = $1", [chatId]);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (error) {
    console.error("Clear chat failed:", error.message);
    res.status(500).json({ ok: false, error: "Не удалось очистить историю чата." });
  }
});

app.post("/api/send-media", requireAdmin, upload.single("file"), async (req, res) => {
  const chatId = String(req.body?.chat_id || "");
  const caption = typeof req.body?.caption === "string" ? req.body.caption.trim() : "";
  const file = req.file;
  if (!/^-?\d+$/.test(chatId) || !file) {
    return res.status(400).json({ ok: false, error: "Выбери файл и проверь Chat ID." });
  }
  if (file?.mimetype.startsWith("image/") && file.size > 10 * 1024 * 1024) {
    return res.status(400).json({ ok: false, error: "Размер фото не должен превышать 10 МБ." });
  }
  if (caption.length > 1024) {
    return res.status(400).json({ ok: false, error: "Подпись к файлу не должна превышать 1024 символа." });
  }

  let method = "sendDocument";
  let field = "document";
  if (file.mimetype.startsWith("image/")) { method = "sendPhoto"; field = "photo"; }
  else if (file.mimetype.startsWith("video/")) { method = "sendVideo"; field = "video"; }
  else if (file.mimetype.startsWith("audio/")) { method = "sendAudio"; field = "audio"; }

  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    if (caption) form.append("caption", caption);
    form.append(field, new Blob([file.buffer], { type: file.mimetype }), file.originalname);
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: "POST", body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) {
      throw new Error(data.description || "Telegram не смог отправить файл.");
    }
    const sent = data.result;
    const label = method === "sendPhoto" ? "[Фото]" : method === "sendVideo" ? "[Видео]" : method === "sendAudio" ? "[Аудио]" : "[Файл]";
    const storedText = caption ? label + " " + caption : label + " " + file.originalname;
    const chat = sent.chat;
    await pool.query(
      `INSERT INTO chats (chat_id, chat_type, title, username, first_name, last_name, last_message_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (chat_id) DO UPDATE SET last_message_at = NOW()`,
      [String(chat.id), chat.type || "private", chat.title || null, chat.username || null, chat.first_name || null, chat.last_name || null]
    );
    await pool.query(
      `INSERT INTO messages (chat_id, telegram_message_id, direction, text, sender_name, created_at)
       VALUES ($1, $2, 'outgoing', $3, 'Вы', NOW()) ON CONFLICT DO NOTHING`,
      [String(chat.id), sent.message_id, storedText]
    );
    res.json({ ok: true, message_id: sent.message_id, media_type: method });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || "Не удалось отправить файл." });
  }
});

app.post("/api/send", requireAdmin, async (req, res) => {
  const chatId = String(req.body?.chat_id || "");
  const messageText = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!/^-?\d+$/.test(chatId) || !messageText || messageText.length > 4096) {
    return res.status(400).json({ ok: false, error: "Проверь Chat ID и текст (до 4096 символов)." });
  }

  try {
    const sent = await telegram("sendMessage", { chat_id: chatId, text: messageText });
    const chat = sent.chat;
    await pool.query(
      `INSERT INTO chats (chat_id, chat_type, title, username, first_name, last_name, last_message_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (chat_id) DO UPDATE SET last_message_at = NOW()`,
      [
        String(chat.id), chat.type || "private", chat.title || null,
        chat.username || null, chat.first_name || null, chat.last_name || null
      ]
    );
    await pool.query(
      `INSERT INTO messages (chat_id, telegram_message_id, direction, text, sender_name, created_at)
       VALUES ($1, $2, 'outgoing', $3, 'Вы', NOW()) ON CONFLICT DO NOTHING`,
      [String(chat.id), sent.message_id, messageText]
    );
    res.json({ ok: true, message_id: sent.message_id });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "Не удалось отправить сообщение." });
  }
});

app.post("/api/webhook/register", requireAdmin, async (req, res) => {
  const publicUrl = String(process.env.RENDER_EXTERNAL_URL || ("https://" + req.get("host"))).replace(/\/$/, "");
  if (!/^https:\/\//i.test(publicUrl)) {
    return res.status(400).json({ ok: false, error: "Не удалось определить HTTPS-адрес Render." });
  }
  try {
    const result = await telegram("setWebhook", {
      url: `${publicUrl}/telegram/webhook`,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "edited_message"],
      drop_pending_updates: false
    });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message });
  }
});

app.use((error, _req, res, _next) => {
  console.error("Request error:", error.message);
  res.status(400).json({ ok: false, error: "Некорректный запрос." });
});

initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => console.log(`Telegram dashboard API listening on ${PORT}`));
  })
  .catch((error) => {
    console.error("Database initialization failed:", error.message);
    process.exit(1);
  });

process.on("SIGTERM", async () => {
  await pool.end().catch(() => {});
  process.exit(0);
});
