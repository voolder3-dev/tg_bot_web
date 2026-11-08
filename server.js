const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("node:child_process");
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
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

function extractMedia(message) {
  if (!message || typeof message !== "object") return null;
  if (message.sticker?.file_id) {
    const sticker = message.sticker;
    const format = sticker.is_animated ? "animated" : sticker.is_video ? "video" : "static";
    return {
      fileId: sticker.file_id,
      stickerFileId: sticker.file_id,
      type: format === "animated" ? "animated_sticker" : format === "video" ? "video_sticker" : "sticker",
      mime: format === "animated" ? "application/x-tgsticker" : format === "video" ? "video/webm" : "image/webp",
      name: null
    };
  }
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    return { fileId: photo.file_id, type: "photo", mime: "image/jpeg", name: null };
  }
  const fields = [
    ["video", "video", "video/mp4"],
    ["animation", "animation", "video/mp4"],
    ["sticker", "sticker", "image/webp"],
    ["document", "document", message.document?.mime_type || "application/octet-stream"],
    ["audio", "audio", message.audio?.mime_type || "audio/mpeg"],
    ["voice", "voice", "audio/ogg; codecs=opus"],
    ["video_note", "video_note", "video/mp4"]
  ];
  for (const [field, type, fallbackMime] of fields) {
    const item = message[field];
    if (item?.file_id) {
      let mediaType = type;
      if (type === "document" && item.mime_type?.startsWith("image/")) mediaType = "photo";
      else if (type === "document" && item.mime_type?.startsWith("video/")) mediaType = "video";
      return {
        fileId: item.file_id,
        stickerFileId: null,
        type: mediaType,
        mime: item.is_video ? "video/webm" : (item.mime_type || fallbackMime),
        name: item.file_name || null
      };
    }
  }
  return null;
}


function convertVoiceToOgg(buffer) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("Конвертер аудио недоступен на сервере."));
    const process = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus",
      "-b:a", "32k", "-f", "ogg", "pipe:1"
    ]);
    const output = [];
    let errorOutput = "";
    process.stdout.on("data", chunk => output.push(chunk));
    process.stderr.on("data", chunk => { errorOutput += chunk.toString(); });
    process.on("error", reject);
    process.on("close", code => {
      if (code !== 0) return reject(new Error(errorOutput.trim() || "Не удалось обработать запись с микрофона."));
      const result = Buffer.concat(output);
      if (!result.length) return reject(new Error("Запись получилась пустой."));
      resolve(result);
    });
    process.stdin.on("error", () => {});
    process.stdin.end(buffer);
  });
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id BIGINT PRIMARY KEY,
      chat_type TEXT NOT NULL DEFAULT 'private',
      title TEXT,
      custom_name TEXT,
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
      media_file_id TEXT,
      media_type TEXT,
      media_mime_type TEXT,
      media_file_name TEXT,
      sticker_file_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE chats ADD COLUMN IF NOT EXISTS custom_name TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_file_id TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_type TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime_type TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_file_name TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS sticker_file_id TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT;

    CREATE TABLE IF NOT EXISTS sticker_packs (
      id BIGSERIAL PRIMARY KEY,
      set_name TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      cover_file_id TEXT,
      sticker_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sticker_pack_items (
      id BIGSERIAL PRIMARY KEY,
      pack_id BIGINT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL,
      preview_file_id TEXT,
      preview_mime_type TEXT,
      media_type TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      emoji TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      UNIQUE(pack_id, file_id)
    );

    ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS cover_file_id TEXT;
    ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS sticker_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sticker_pack_items ADD COLUMN IF NOT EXISTS preview_file_id TEXT;
    ALTER TABLE sticker_pack_items ADD COLUMN IF NOT EXISTS preview_mime_type TEXT;
    ALTER TABLE sticker_pack_items ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'sticker';
    ALTER TABLE sticker_pack_items ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT 'image/webp';
    ALTER TABLE sticker_pack_items ADD COLUMN IF NOT EXISTS emoji TEXT;
    ALTER TABLE sticker_pack_items ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;

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
    const media = extractMedia(message);
    const mediaLabels = {
      photo: "[Фото]", video: "[Видео]", animation: "[GIF]", sticker: "[Стикер]",
      animated_sticker: "[Анимированный стикер]", video_sticker: "[Видеостикер]",
      document: "[Файл]", audio: "[Аудио]", voice: "[Голосовое сообщение]",
      video_note: "[Видеосообщение]"
    };
    const textValue = typeof message.text === "string"
      ? message.text
      : (message.caption || (media ? mediaLabels[media.type] || "[Медиа]" : "[Сообщение без текста]"));

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
      `INSERT INTO messages
       (chat_id, telegram_message_id, direction, text, sender_name, media_file_id, media_type, media_mime_type, media_file_name, sticker_file_id, reply_to_message_id, created_at)
       VALUES ($1, $2, 'incoming', $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11))
       ON CONFLICT DO NOTHING`,
      [
        String(chat.id), message.message_id || null, String(textValue).slice(0, 4096),
        [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || null,
        media?.fileId || null, media?.type || null, media?.mime || null, media?.name || null, media?.stickerFileId || null,
        message.reply_to_message?.message_id || null,
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
      `SELECT c.chat_id::text AS chat_id, c.chat_type, c.title, c.custom_name, c.username,
              c.first_name, c.last_name, c.last_message_at,
              m.text AS last_message, m.id::text AS last_message_id, m.direction AS last_message_direction
       FROM chats c
       LEFT JOIN LATERAL (
         SELECT text, id, direction FROM messages WHERE chat_id = c.chat_id
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

app.get("/api/chats/:chatId/avatar", requireAdmin, async (req, res) => {
  const chatId = req.params.chatId;
  if (!/^-?\\d+$/.test(chatId)) return res.status(400).json({ ok: false, error: "Некорректный Chat ID." });
  try {
    const chat = await telegram("getChat", { chat_id: chatId });
    const fileId = chat.photo?.small_file_id || chat.photo?.big_file_id;
    if (!fileId) return res.sendStatus(404);
    const fileInfo = await telegram("getFile", { file_id: fileId });
    if (!fileInfo.file_path) return res.sendStatus(404);
    const fileResponse = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`);
    if (!fileResponse.ok) throw new Error("Telegram avatar HTTP " + fileResponse.status);
    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    if (!buffer.length) return res.sendStatus(404);
    res.setHeader("Content-Type", fileResponse.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
  } catch (error) {
    console.warn("Chat avatar unavailable:", error.message);
    res.sendStatus(404);
  }
});

app.patch("/api/chats/:chatId/name", requireAdmin, async (req, res) => {
  const chatId = req.params.chatId;
  const customName = typeof req.body?.custom_name === "string" ? req.body.custom_name.trim() : "";
  if (!/^-?\d+$/.test(chatId)) return res.status(400).json({ ok: false, error: "Некорректный Chat ID." });
  if (customName.length > 64) return res.status(400).json({ ok: false, error: "Имя должно содержать не более 64 символов." });
  try {
    const result = await pool.query("UPDATE chats SET custom_name = $2 WHERE chat_id = $1 RETURNING chat_id::text AS chat_id, custom_name", [chatId, customName || null]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Чат не найден." });
    res.json({ ok: true, chat: result.rows[0] });
  } catch (error) {
    console.error("Chat display name update failed:", error.message);
    res.status(500).json({ ok: false, error: "Не удалось сохранить имя пользователя." });
  }
});

app.get("/api/chats/:chatId/messages", requireAdmin, async (req, res) => {
  const chatId = req.params.chatId;
  if (!/^-?\d+$/.test(chatId)) {
    return res.status(400).json({ ok: false, error: "Некорректный Chat ID." });
  }
  try {
    const result = await pool.query(
      `SELECT id, telegram_message_id, direction, text, sender_name,
              media_type, media_mime_type, media_file_name, reply_to_message_id, created_at
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

app.get("/api/media/:messageId", requireAdmin, async (req, res) => {
  const messageId = req.params.messageId;
  if (!/^\d+$/.test(messageId)) return res.status(400).json({ ok: false, error: "Некорректный ID медиа." });
  try {
    let result = await pool.query(
      "SELECT media_file_id, media_mime_type, media_file_name FROM messages WHERE id = $1 AND media_file_id IS NOT NULL",
      [messageId]
    );
    if (!result.rows.length) {
      result = await pool.query(
        "SELECT COALESCE(preview_file_id, file_id) AS media_file_id, mime_type AS media_mime_type, NULL AS media_file_name FROM sticker_pack_items WHERE id = $1",
        [messageId]
      );
    }
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Файл не найден." });
    const media = result.rows[0];
    let fileBuffer = null;
    let contentType = media.media_mime_type || "application/octet-stream";
    let lastError = null;
    // Telegram/Render connections can fail transiently; retry the complete download.
    for (let attempt = 1; attempt <= 3; attempt++) {
      let controller;
      let timeout;
      try {
        const fileInfo = await telegram("getFile", { file_id: media.media_file_id });
        if (!fileInfo.file_path) throw new Error("Telegram не вернул путь к файлу.");
        controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 60000);
        const fileResponse = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`, { signal: controller.signal });
        if (!fileResponse.ok || !fileResponse.body) throw new Error("Telegram file HTTP " + fileResponse.status);
        const data = Buffer.from(await fileResponse.arrayBuffer());
        if (!data.length) throw new Error("Telegram вернул пустой файл.");
        fileBuffer = data;
        contentType = media.media_mime_type || fileResponse.headers.get("content-type") || contentType;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`Media download attempt ${attempt}/3 failed:`, error.message);
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 700));
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    if (!fileBuffer) throw lastError || new Error("Не удалось получить файл из Telegram.");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Length", String(fileBuffer.length));
    res.end(fileBuffer);
  } catch (error) {
    console.error("Media proxy failed:", error.message);
    if (!res.headersSent) res.status(502).json({ ok: false, error: "Не удалось загрузить медиа из Telegram." });
    else res.destroy(error);
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
      `INSERT INTO messages
       (chat_id, telegram_message_id, direction, text, sender_name, media_file_id, media_type, media_mime_type, media_file_name, created_at)
       VALUES ($1, $2, 'outgoing', $3, 'Вы', $4, $5, $6, $7, NOW()) ON CONFLICT DO NOTHING`,
      [
        String(chat.id), sent.message_id, storedText,
        extractMedia(sent)?.fileId || null, extractMedia(sent)?.type || null,
        extractMedia(sent)?.mime || null, extractMedia(sent)?.name || file.originalname || null
      ]
    );
    res.json({ ok: true, message_id: sent.message_id, media_type: method });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || "Не удалось отправить файл." });
  }
});


app.post("/api/send-voice", requireAdmin, upload.single("voice"), async (req, res) => {
  const chatId = String(req.body?.chat_id || "");
  const file = req.file;
  if (!/^-?\d+$/.test(chatId) || !file) {
    return res.status(400).json({ ok: false, error: "Запиши голосовое сообщение и выбери чат." });
  }
  if (!file.mimetype.startsWith("audio/")) {
    return res.status(400).json({ ok: false, error: "Файл записи должен быть аудио." });
  }
  if (file.size > 20 * 1024 * 1024) {
    return res.status(400).json({ ok: false, error: "Голосовое сообщение не должно превышать 20 МБ." });
  }

  try {
    const oggVoice = await convertVoiceToOgg(file.buffer);
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("voice", new Blob([oggVoice], { type: "audio/ogg" }), "voice.ogg");
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVoice`, {
      method: "POST",
      body: form
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) {
      throw new Error(data.description || "Telegram не смог отправить голосовое сообщение.");
    }

    const sent = data.result;
    const chat = sent.chat;
    await pool.query(
      `INSERT INTO chats (chat_id, chat_type, title, username, first_name, last_name, last_message_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (chat_id) DO UPDATE SET last_message_at = NOW()`,
      [String(chat.id), chat.type || "private", chat.title || null, chat.username || null, chat.first_name || null, chat.last_name || null]
    );
    await pool.query(
      `INSERT INTO messages
       (chat_id, telegram_message_id, direction, text, sender_name, media_file_id, media_type, media_mime_type, media_file_name, created_at)
       VALUES ($1, $2, 'outgoing', $3, 'Вы', $4, 'voice', 'audio/ogg', 'voice.ogg', NOW())
       ON CONFLICT DO NOTHING`,
      [String(chat.id), sent.message_id, "[Голосовое сообщение]", sent.voice?.file_id || null]
    );
    res.json({ ok: true, message_id: sent.message_id, media_type: "voice" });
  } catch (error) {
    console.error("Voice send failed:", error.message);
    res.status(502).json({ ok: false, error: error.message || "Не удалось отправить голосовое сообщение." });
  }
});

app.post("/api/send", requireAdmin, async (req, res) => {
  const chatId = String(req.body?.chat_id || "");
  const messageText = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const replyTo = req.body?.reply_to_message_id ? Number(req.body.reply_to_message_id) : null;
  if (!/^-?\d+$/.test(chatId) || !messageText || messageText.length > 4096 || (replyTo !== null && (!Number.isSafeInteger(replyTo) || replyTo < 1))) {
    return res.status(400).json({ ok: false, error: "Проверь Chat ID и текст (до 4096 символов)." });
  }

  try {
    const payload = { chat_id: chatId, text: messageText };
    if (replyTo) payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    const sent = await telegram("sendMessage", payload);
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
      `INSERT INTO messages (chat_id, telegram_message_id, direction, text, sender_name, reply_to_message_id, created_at)
       VALUES ($1, $2, 'outgoing', $3, 'Вы', $4, NOW()) ON CONFLICT DO NOTHING`,
      [String(chat.id), sent.message_id, messageText, replyTo]
    );
    res.json({ ok: true, message_id: sent.message_id });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "Не удалось отправить сообщение." });
  }
});


app.get("/api/stickers", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (COALESCE(sticker_file_id, media_file_id)) id::text AS id, media_file_id,
         COALESCE(sticker_file_id, media_file_id) AS sticker_file_id, media_type, text, created_at
       FROM messages WHERE media_type IN ('sticker','video_sticker','animated_sticker') AND media_file_id IS NOT NULL
       ORDER BY COALESCE(sticker_file_id, media_file_id), created_at DESC LIMIT 60`
    );
    res.json({ ok: true, stickers: result.rows });
  } catch (error) {
    console.error("Sticker list failed:", error.message);
    res.status(500).json({ ok: false, error: "Не удалось загрузить недавние стикеры." });
  }
});

app.get("/api/sticker-packs", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id::text AS id, p.set_name, p.title, p.sticker_count,
              i.id::text AS cover_id, i.media_type AS cover_type, i.preview_mime_type AS cover_preview_mime_type
       FROM sticker_packs p
       LEFT JOIN LATERAL (
         SELECT id, media_type FROM sticker_pack_items
         WHERE pack_id = p.id ORDER BY position ASC LIMIT 1
       ) i ON TRUE
       ORDER BY p.created_at DESC`
    );
    res.json({ ok: true, packs: result.rows });
  } catch (error) {
    console.error("Sticker packs list failed:", error.message);
    res.status(500).json({ ok: false, error: "Не удалось загрузить наборы стикеров." });
  }
});

app.post("/api/sticker-packs/import", requireAdmin, async (req, res) => {
  const input = String(req.body?.link || req.body?.set_name || "").trim();
  const match = input.match(/(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]+)/i) || input.match(/^([A-Za-z][A-Za-z0-9_]{0,63})$/);
  if (!match) return res.status(400).json({ ok: false, error: "Вставь ссылку вида https://t.me/addstickers/НазваниеНабора." });
  const setName = match[1];
  try {
    const stickerSet = await telegram("getStickerSet", { name: setName });
    if (!Array.isArray(stickerSet.stickers) || !stickerSet.stickers.length) {
      return res.status(404).json({ ok: false, error: "Telegram вернул пустой набор." });
    }
    const packResult = await pool.query(
      `INSERT INTO sticker_packs (set_name, title, sticker_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (set_name) DO UPDATE SET title = EXCLUDED.title, sticker_count = EXCLUDED.sticker_count
       RETURNING id`,
      [stickerSet.name, stickerSet.title || stickerSet.name, stickerSet.stickers.length]
    );
    const packId = packResult.rows[0].id;
    for (let position = 0; position < stickerSet.stickers.length; position++) {
      const sticker = stickerSet.stickers[position];
      const mediaType = sticker.is_animated ? "animated_sticker" : sticker.is_video ? "video_sticker" : "sticker";
      const mimeType = sticker.is_animated ? "application/x-tgsticker" : sticker.is_video ? "video/webm" : "image/webp";
      await pool.query(
        `INSERT INTO sticker_pack_items (pack_id, file_id, preview_file_id, preview_mime_type, media_type, mime_type, emoji, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (pack_id, file_id) DO UPDATE SET
           preview_file_id = EXCLUDED.preview_file_id, preview_mime_type = EXCLUDED.preview_mime_type, media_type = EXCLUDED.media_type,
           mime_type = EXCLUDED.mime_type, emoji = EXCLUDED.emoji, position = EXCLUDED.position`,
        [packId, sticker.file_id, sticker.thumbnail?.file_id || (mediaType === "sticker" ? sticker.file_id : null), sticker.thumbnail ? "image/webp" : (mediaType === "sticker" ? "image/webp" : mimeType), mediaType, mimeType, sticker.emoji || null, position]
      );
    }
    const cover = stickerSet.stickers[0];
    res.json({ ok: true, pack: { id: String(packId), set_name: stickerSet.name, title: stickerSet.title || stickerSet.name, sticker_count: stickerSet.stickers.length, cover_type: cover.is_animated ? "animated_sticker" : cover.is_video ? "video_sticker" : "sticker" } });
  } catch (error) {
    console.error("Sticker pack import failed:", error.message);
    const status = error.status === 400 ? 400 : error.status || 502;
    res.status(status).json({ ok: false, error: error.message || "Не удалось импортировать набор из Telegram." });
  }
});

app.get("/api/sticker-packs/:packId/stickers", requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.packId)) return res.status(400).json({ ok: false, error: "Некорректный ID набора." });
  try {
    const pack = await pool.query("SELECT id::text, set_name, title, sticker_count FROM sticker_packs WHERE id = $1", [req.params.packId]);
    if (!pack.rows.length) return res.status(404).json({ ok: false, error: "Набор не найден." });
    const stickers = await pool.query(
      `SELECT id::text, file_id, media_type, preview_mime_type, emoji
       FROM sticker_pack_items WHERE pack_id = $1 ORDER BY position ASC`,
      [req.params.packId]
    );
    res.json({ ok: true, pack: pack.rows[0], stickers: stickers.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Не удалось открыть набор стикеров." });
  }
});

app.get("/api/sticker-library/media/:itemId", requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.itemId)) return res.status(400).json({ ok: false, error: "Некорректный ID стикера." });
  try {
    const result = await pool.query("SELECT COALESCE(preview_file_id, file_id) AS file_id, COALESCE(preview_mime_type, mime_type) AS mime_type FROM sticker_pack_items WHERE id = $1", [req.params.itemId]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Превью стикера не найдено." });
    const fileInfo = await telegram("getFile", { file_id: result.rows[0].file_id });
    const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`);
    if (!response.ok) throw new Error("Telegram file HTTP " + response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error("Telegram вернул пустое превью.");
    const previewMime = /\.(?:webp)$/i.test(fileInfo.file_path) ? "image/webp" : /\.(?:jpe?g)$/i.test(fileInfo.file_path) ? "image/jpeg" : result.rows[0].mime_type;
    res.setHeader("Content-Type", previewMime);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(buffer);
  } catch (error) {
    console.error("Sticker library preview failed:", error.message);
    if (!res.headersSent) res.status(502).json({ ok: false, error: "Не удалось загрузить превью стикера." });
  }
});

app.post("/api/chat-action", requireAdmin, async (req, res) => {
  const chatId = String(req.body?.chat_id || "");
  if (!/^-?\d+$/.test(chatId)) return res.status(400).json({ ok: false, error: "Некорректный Chat ID." });
  try {
    await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "Не удалось показать индикатор набора." });
  }
});

app.post("/api/react-message", requireAdmin, async (req, res) => {
  const chatId = String(req.body?.chat_id || "");
  const messageId = Number(req.body?.message_id);
  const emoji = typeof req.body?.emoji === "string" ? req.body.emoji : "";
  const allowed = ["👍","👎","❤","🔥","🎉","😁","😢","🤔","👏","💯"];
  const remove = req.body?.remove === true;
  if (!/^-?\d+$/.test(chatId) || !Number.isSafeInteger(messageId) || messageId < 1 || (!remove && !allowed.includes(emoji))) {
    return res.status(400).json({ ok: false, error: "Проверь сообщение и выбранную реакцию." });
  }
  try {
    await telegram("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: remove ? [] : [{ type: "emoji", emoji }] });
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "Telegram не разрешил поставить реакцию." });
  }
});

app.post("/api/send-sticker", requireAdmin, async (req, res) => {
  const chatId = String(req.body?.chat_id || "");
  const fileId = typeof req.body?.file_id === "string" ? req.body.file_id : "";
  if (!/^-?\d+$/.test(chatId) || !fileId || fileId.length > 512) {
    return res.status(400).json({ ok: false, error: "Выбери стикер и чат." });
  }
  try {
    const sent = await telegram("sendSticker", { chat_id: chatId, sticker: fileId });
    const chat = sent.chat;
    await pool.query(
      `INSERT INTO chats (chat_id, chat_type, title, username, first_name, last_name, last_message_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (chat_id) DO UPDATE SET last_message_at=NOW()`,
      [String(chat.id), chat.type || "private", chat.title || null, chat.username || null, chat.first_name || null, chat.last_name || null]
    );
    const sticker = sent.sticker || {};
    const stickerType = sticker.is_animated ? "animated_sticker" : sticker.is_video ? "video_sticker" : "sticker";
    const stickerMime = sticker.is_animated ? "application/x-tgsticker" : sticker.is_video ? "video/webm" : "image/webp";
    await pool.query(
      `INSERT INTO messages (chat_id, telegram_message_id, direction, text, sender_name, media_file_id, media_type, media_mime_type, sticker_file_id, created_at)
       VALUES ($1,$2,'outgoing','[Стикер]','Вы',$3,$4,$5,$3,NOW()) ON CONFLICT DO NOTHING`,
      [String(chat.id), sent.message_id, sticker.file_id || fileId, stickerType, stickerMime]
    );
    res.json({ ok: true, message_id: sent.message_id });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "Не удалось отправить стикер." });
  }
});

app.get("/api/search", requireAdmin, async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 120);
  if (query.length < 2) return res.json({ ok: true, results: [] });
  try {
    const result = await pool.query(
      `SELECT m.id::text AS id, m.chat_id::text AS chat_id, m.telegram_message_id,
              m.direction, m.text, m.media_type, m.created_at,
              COALESCE(c.custom_name, c.title, NULLIF(CONCAT_WS(' ', c.first_name, c.last_name), ''), c.username, c.chat_id::text) AS chat_name
       FROM messages m JOIN chats c ON c.chat_id = m.chat_id
       WHERE m.text ILIKE $1
       ORDER BY m.created_at DESC LIMIT 80`,
      ["%" + query + "%"]
    );
    res.json({ ok: true, results: result.rows });
  } catch (error) {
    console.error("Global message search failed:", error.message);
    res.status(500).json({ ok: false, error: "Не удалось выполнить поиск по сообщениям." });
  }
});

app.patch("/api/chats/:chatId/messages/:messageId", requireAdmin, async (req, res) => {
  const chatId = req.params.chatId;
  const localId = req.params.messageId;
  const textValue = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!/^-?\d+$/.test(chatId) || !/^\d+$/.test(localId) || !textValue || textValue.length > 4096) {
    return res.status(400).json({ ok: false, error: "Проверь текст сообщения (от 1 до 4096 символов)." });
  }
  try {
    const found = await pool.query(
      "SELECT telegram_message_id, direction, created_at, media_type FROM messages WHERE id = $1 AND chat_id = $2",
      [localId, chatId]
    );
    if (!found.rows.length) return res.status(404).json({ ok: false, error: "Сообщение не найдено." });
    const message = found.rows[0];
    if (message.direction !== "outgoing" || message.media_type || !message.telegram_message_id) {
      return res.status(400).json({ ok: false, error: "Можно редактировать только отправленные текстовые сообщения." });
    }
    await telegram("editMessageText", { chat_id: chatId, message_id: Number(message.telegram_message_id), text: textValue });
    await pool.query("UPDATE messages SET text = $3 WHERE id = $1 AND chat_id = $2", [localId, chatId, textValue]);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "Не удалось отредактировать сообщение." });
  }
});

app.post("/api/forward-message", requireAdmin, async (req, res) => {
  const sourceChatId = String(req.body?.source_chat_id || "");
  const targetChatId = String(req.body?.target_chat_id || "");
  const messageId = Number(req.body?.message_id);
  if (!/^-?\d+$/.test(sourceChatId) || !/^-?\d+$/.test(targetChatId) || !Number.isSafeInteger(messageId) || messageId < 1 || sourceChatId === targetChatId) {
    return res.status(400).json({ ok: false, error: "Выбери другой чат для пересылки." });
  }
  try {
    const source = await pool.query(
      "SELECT text, media_file_id, media_type, media_mime_type, media_file_name FROM messages WHERE chat_id=$1 AND telegram_message_id=$2 ORDER BY id DESC LIMIT 1",
      [sourceChatId, messageId]
    );
    const sent = await telegram("copyMessage", { chat_id: targetChatId, from_chat_id: sourceChatId, message_id: messageId });
    const chat = await pool.query("SELECT chat_type,title,username,first_name,last_name FROM chats WHERE chat_id=$1", [targetChatId]);
    const info = chat.rows[0] || {};
    await pool.query(
      `INSERT INTO chats (chat_id, chat_type, title, username, first_name, last_name, last_message_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (chat_id) DO UPDATE SET last_message_at=NOW()`,
      [targetChatId, info.chat_type || "private", info.title || null, info.username || null, info.first_name || null, info.last_name || null]
    );
    const original = source.rows[0] || {};
    await pool.query(
      `INSERT INTO messages (chat_id, telegram_message_id, direction, text, sender_name, media_file_id, media_type, media_mime_type, media_file_name, created_at)
       VALUES ($1,$2,'outgoing',$3,'Вы',$4,$5,$6,$7,NOW()) ON CONFLICT DO NOTHING`,
      [targetChatId, sent.message_id, original.text || "[Пересланное сообщение]", original.media_file_id || null, original.media_type || null, original.media_mime_type || null, original.media_file_name || null]
    );
    res.json({ ok: true, message_id: sent.message_id });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "Не удалось переслать сообщение." });
  }
});

app.post("/api/pin-message", requireAdmin, async (req, res) => {
  const chatId = String(req.body?.chat_id || "");
  const messageId = Number(req.body?.message_id);
  if (!/^-?\d+$/.test(chatId) || !Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ ok: false, error: "Проверь Chat ID и ID сообщения." });
  try {
    const result = await telegram("pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: true });
    res.json({ ok: true, result });
  } catch (error) { res.status(error.status || 502).json({ ok: false, error: error.message || "Не удалось закрепить сообщение." }); }
});

app.post("/api/unpin-message", requireAdmin, async (req, res) => {
  const chatId = String(req.body?.chat_id || "");
  const messageId = req.body?.message_id ? Number(req.body.message_id) : undefined;
  if (!/^-?\d+$/.test(chatId) || (messageId !== undefined && (!Number.isSafeInteger(messageId) || messageId < 1))) return res.status(400).json({ ok: false, error: "Проверь Chat ID и ID сообщения." });
  try {
    const payload = { chat_id: chatId };
    if (messageId) payload.message_id = messageId;
    const result = await telegram("unpinChatMessage", payload);
    res.json({ ok: true, result });
  } catch (error) { res.status(error.status || 502).json({ ok: false, error: error.message || "Не удалось открепить сообщение." }); }
});

app.get("/api/chats/:chatId/pinned", requireAdmin, async (req, res) => {
  const chatId = req.params.chatId;
  if (!/^-?\d+$/.test(chatId)) return res.status(400).json({ ok: false, error: "Некорректный Chat ID." });
  try {
    const chat = await telegram("getChat", { chat_id: chatId });
    res.json({ ok: true, pinned_message: chat.pinned_message || null });
  } catch (error) { res.status(error.status || 502).json({ ok: false, error: error.message || "Не удалось загрузить закреплённое сообщение." }); }
});

app.delete("/api/chats/:chatId/messages/:messageId", requireAdmin, async (req, res) => {
  const chatId = req.params.chatId;
  const localId = req.params.messageId;
  if (!/^-?\d+$/.test(chatId) || !/^\d+$/.test(localId)) return res.status(400).json({ ok: false, error: "Некорректный ID сообщения." });
  try {
    const found = await pool.query("SELECT telegram_message_id FROM messages WHERE id = $1 AND chat_id = $2", [localId, chatId]);
    if (!found.rows.length) return res.status(404).json({ ok: false, error: "Сообщение уже удалено или не найдено." });
    const telegramId = found.rows[0].telegram_message_id;
    if (telegramId) await telegram("deleteMessage", { chat_id: chatId, message_id: Number(telegramId) });
    await pool.query("DELETE FROM messages WHERE id = $1 AND chat_id = $2", [localId, chatId]);
    await pool.query("UPDATE chats SET last_message_at = (SELECT MAX(created_at) FROM messages WHERE chat_id = $1) WHERE chat_id = $1", [chatId]);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 502).json({ ok: false, error: error.message || "Не удалось удалить сообщение. Telegram может запрещать удаление старых сообщений." });
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
