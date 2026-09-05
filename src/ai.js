"use strict";

const { OpenAI } = require("openai");

// Responses API у Yandex совместим с OpenAI, поэтому работаем официальным SDK —
// ровно как в примере кода из Agent Atelier
const DEFAULT_BASE_URL = "https://ai.api.cloud.yandex.net/v1";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 1;

let client = null;

const getClient = () => {
  if (client) return client;

  client = new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL || DEFAULT_BASE_URL,
    defaultHeaders: { "OpenAI-Project": process.env.YC_FOLDER_ID },
    timeout: Number(process.env.AI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    // Ретраев мало осознанно: у функции всего 120 секунд на весь запуск
    maxRetries: process.env.AI_MAX_RETRIES ? Number(process.env.AI_MAX_RETRIES) : DEFAULT_MAX_RETRIES,
  });

  return client;
};

const extractText = (response) => {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  // Запасной разбор: в output кроме message бывают reasoning и вызовы инструментов
  const parts = [];
  for (const item of response.output || []) {
    if (item.type !== "message") continue;
    for (const chunk of item.content || []) {
      if (typeof chunk.text === "string") parts.push(chunk.text);
    }
  }

  return parts.join("\n").trim();
};

const buildInput = (letter) =>
  [`Письмо от: ${letter.from}`, `Тема: ${letter.subject || "(без темы)"}`, "", letter.text].join("\n");

// Агент со своей инструкцией и моделью живёт в Agent Atelier, тут только его идентификатор
const askAgent = async (letter) => {
  let response;

  try {
    response = await getClient().responses.create({
      prompt: { id: process.env.AI_AGENT_ID },
      input: buildInput(letter),
    });
  } catch (error) {
    if (error?.status) throw new Error(`Responses API: ${error.message}`);
    throw error;
  }

  const answer = extractText(response);
  if (!answer) {
    throw new Error(`в ответе агента нет текста: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return answer;
};

module.exports = { askAgent, extractText, buildInput };
