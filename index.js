require("dotenv").config();

const { Telegraf } = require("telegraf");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN не указан");
}

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY не указан");
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const memory = new Map();

function getHistory(userId) {
  if (!memory.has(userId)) memory.set(userId, []);
  return memory.get(userId);
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });

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

async function downloadTelegramFile(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const filePath = path.join(__dirname, `voice_${Date.now()}.ogg`);

  const response = await axios({
    method: "GET",
    url: link.href,
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

bot.start((ctx) => {
  ctx.reply(
    "Привет! Я GPT-бот в Telegram.\n\nМожешь писать текстом или отправлять голосовые.\n\nКоманды:\n/start — запуск\n/clear — очистить память"
  );
});

bot.command("clear", (ctx) => {
  memory.delete(ctx.from.id);
  ctx.reply("Память диалога очищена.");
});

bot.on("voice", async (ctx) => {
  const userId = ctx.from.id;

  try {
    await ctx.reply("Распознаю голосовое...");

    const filePath = await downloadTelegramFile(ctx, ctx.message.voice.file_id);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "gpt-4o-transcribe",
    });

    fs.unlinkSync(filePath);

    const userText = transcription.text;
    await ctx.reply(`Ты сказал: ${userText}`);

    const answer = await askGPT(userId, userText);
    await ctx.reply(answer);
  } catch (error) {
    console.error(error);
    await ctx.reply("Ошибка при обработке голосового сообщения.");
  }
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (text.startsWith("/")) return;

  try {
    await ctx.sendChatAction("typing");

    const answer = await askGPT(userId, text);
    await ctx.reply(answer);
  } catch (error) {
    console.error(error);
    await ctx.reply(
      "Ошибка при обращении к GPT. Проверь OPENAI_API_KEY, TELEGRAM_BOT_TOKEN и баланс OpenAI."
    );
  }
});

bot.launch();

console.log("Telegram GPT bot запущен");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));