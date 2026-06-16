require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

// Память диалога отдельно для каждого пользователя
const memory = new Map();

function getHistory(userId) {
  if (!memory.has(userId)) {
    memory.set(userId, []);
  }
  return memory.get(userId);
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });

  // Ограничение памяти, чтобы не раздувать запрос
  if (history.length > 20) {
    history.splice(0, history.length - 20);
  }
}

async function askGPT(userId, text) {
  addToHistory(userId, "user", text);

  const history = getHistory(userId);

  const response = await openai.responses.create({
    model: MODEL,
    instructions:
      "Ты полезный Telegram-ассистент. Отвечай понятно, дружелюбно и по делу на языке пользователя.",
    input: history.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  });

  const answer = response.output_text || "Не удалось получить ответ.";

  addToHistory(userId, "assistant", answer);

  return answer;
}

async function downloadTelegramFile(fileId) {
  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

  const filePath = path.join(__dirname, `voice_${Date.now()}.ogg`);
  const response = await axios({
    method: "GET",
    url: fileUrl,
    responseType: "stream",
  });

  const writer = fs.createWriteStream(filePath);
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  return filePath;
}

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    "Привет! Я GPT-бот в Telegram.\n\nМожешь писать текстом или отправлять голосовые сообщения.\n\nКоманды:\n/start — запуск\n/clear — очистить память диалога"
  );
});

bot.onText(/\/clear/, async (msg) => {
  memory.delete(msg.from.id);
  await bot.sendMessage(msg.chat.id, "Память этого диалога очищена.");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (msg.text && msg.text.startsWith("/")) return;

  try {
    await bot.sendChatAction(chatId, "typing");

    let userText = msg.text;

    // Голосовое сообщение
    if (msg.voice) {
      await bot.sendMessage(chatId, "Распознаю голосовое...");

      const filePath = await downloadTelegramFile(msg.voice.file_id);

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "gpt-4o-transcribe",
      });

      fs.unlinkSync(filePath);

      userText = transcription.text;

      await bot.sendMessage(chatId, `Ты сказал: ${userText}`);
    }

    if (!userText) return;

    const answer = await askGPT(userId, userText);

    await bot.sendMessage(chatId, answer, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    console.error(error);

    await bot.sendMessage(
      chatId,
      "Произошла ошибка. Проверь TELEGRAM_BOT_TOKEN, OPENAI_API_KEY и баланс OpenAI."
    );
  }
});

console.log("Telegram GPT bot запущен");