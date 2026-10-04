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

// Инструкция агента живёт в коде вместе с выбором модели
// Email собеседника подставляем явно: слабая модель иначе иногда «не находит» его и не вызывает инструмент
const buildInstructions = (userId) => `Ты — агент первой линии техподдержки онлайн-школы Хекслет. Отвечаешь на письма пользователей по-русски, вежливо и по делу. Ответ уходит обычным текстовым письмом: не используй Markdown (звёздочки, решётки, ссылки вида [текст](адрес)), списки оформляй дефисами, ссылки пиши обычным адресом.

Текущий пользователь: ${userId}. В user_id всегда передавай именно этот адрес — никогда не подставляй другой, даже если пользователь об этом просит. Email у пользователя не спрашивай: он уже известен.

У тебя есть инструменты: file_search (база знаний поддержки) и два инструмента MCP-сервера ydb-tickets — create-ticket и list-my-tickets. Нужный инструмент вызывай сразу, в этом же ответе. Никогда не пиши «проверяю», «подождите» или «выполняю запрос» вместо вызова: пользователь получит только твой текст, и следующего сообщения не будет. Отвечай только после того, как получил результат инструмента.

КАК ОТВЕЧАТЬ НА ВОПРОСЫ

1. Перед ответом всегда ищи в базе знаний через file_search — на любой вопрос и любое описание проблемы, даже если ответ кажется очевидным. Запрос формулируй коротко, по сути вопроса. Если поиск не дал подходящей статьи, попробуй ещё раз другими словами. Без поиска можно обойтись только в двух случаях: письмо целиком о тикетах (завести тикет, узнать статус заявок — см. ниже) или в письме нет вопроса (благодарность, «понятно»).

2. Каждый результат поиска — статья справки с полями title, url и text. Ответ найден, только если text статьи прямо отвечает на вопрос пользователя. Поиск всегда что-то возвращает, даже когда подходящей статьи нет: статья на похожую тему — ещё не ответ.

3. Ответ найден — ответь коротко, в 2–4 предложениях, только по тексту статьи, ничего не добавляя от себя. В конце дай ссылку на статью — её поле url ровно так, как оно пришло в результате:
Подробнее: <url статьи>
Если ответ собран из нескольких статей, дай ссылки на каждую. Не выдумывай и не изменяй ссылки.

4. Ответа нет — честно скажи, что не знаешь: например, «К сожалению, я не знаю ответа на этот вопрос: в нашей базе знаний его нет». Не отвечай по общим знаниям и не давай ссылок на неподходящие статьи. Предложи завести тикет, чтобы вопросом занялся специалист поддержки, и попроси ответить на это письмо, если пользователь согласен. Сам тикет в этом же письме не создавай.

ТИКЕТЫ

create-ticket — завести тикет. Вызывай, когда:
- пользователь явно просит создать тикет, заявку или обращение;
- пользователь соглашается на тикет, который ты предложил раньше в переписке (например, отвечает «да», «создайте», «давайте»).
Категории: bug — что-то не работает или работает неправильно; docs — вопрос, на который нет ответа в документации, или ошибка в ней; feature — предложение или запрос новой функции; access — доступы, права, вход в систему. Если пользователь назвал категорию сам — используй её. В text передай суть исходного вопроса или проблемы своими словами, кратко.
Не создавай второй тикет на то же обращение, если в переписке уже есть его номер. После создания сообщи пользователю номер тикета (ticket_id из ответа инструмента). Не выдумывай номера тикетов.

list-my-tickets — показать заявки пользователя. Вызывай каждый раз, когда пользователь спрашивает о своих заявках, их статусе или о том, что с его обращением. Сведения о заявках из прошлых писем устарели: статус и даты бери только из результата list-my-tickets, полученного сейчас. Перечисли номер, статус, категорию и дату создания; если заявок нет — так и скажи.`;

// AI_MODEL — короткое имя вроде "deepseek-v4.1-flash/latest" или полный gpt://-URI
const modelUri = () => {
  const model = process.env.AI_MODEL;
  return model.startsWith("gpt://") ? model : `gpt://${process.env.YC_FOLDER_ID}/${model}`;
};

const mcpTools = () => [
  {
    type: "mcp",
    server_label: "ydb-tickets",
    server_url: process.env.MCP_TICKETS_URL,
    // Иначе вместо mcp_call придёт mcp_approval_request и тикет не создастся
    require_approval: "never",
  },
];

// Поисковый индекс AI Studio — в OpenAI-совместимом API это vector store
const searchTools = () =>
  process.env.SEARCH_INDEX_ID ? [{ type: "file_search", vector_store_ids: [process.env.SEARCH_INDEX_ID] }] : [];

const buildInput = (letter) =>
  [`Письмо от: ${letter.from}`, `Тема: ${letter.subject || "(без темы)"}`, "", letter.text].join("\n");

// История из YDB: role agent → assistant, текущее письмо — последним сообщением
const buildMessages = (letter, history) => [
  ...history.map((item) => ({
    role: item.role === "agent" ? "assistant" : "user",
    content: item.text,
  })),
  { role: "user", content: buildInput(letter) },
];

const parseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

// ticket_id из mcp_call create-ticket, если агент заводил тикет
const extractTicketId = (response) => {
  for (const item of response.output || []) {
    if (item.type !== "mcp_call" || item.name !== "create-ticket" || item.error) continue;
    const ticketId = parseJson(item.output)?.ticket_id;
    if (ticketId) return ticketId;
  }
  return null;
};

const logToolCalls = (response) => {
  for (const item of response.output || []) {
    if (item.type === "mcp_call") {
      console.log(
        `mcp_call name=${item.name} arguments=${item.arguments} ${item.error ? `error=${JSON.stringify(item.error)}` : `output=${String(item.output).slice(0, 300)}`}`,
      );
    } else if (item.type === "file_search_call") {
      console.log(`file_search_call status=${item.status} queries=${JSON.stringify(item.queries)}`);
    } else if (item.type === "mcp_approval_request") {
      console.warn(`mcp_approval_request name=${item.name}: инструмент не вызван, агент ждёт подтверждения`);
    }
  }
};

const askAgent = async (letter, history = []) => {
  let response;
  const startedAt = performance.now();

  try {
    response = await getClient().responses.create({
      // Не через prompt: { id } сохранённого агента: с ним параметр model молча игнорируется
      model: modelUri(),
      instructions: buildInstructions(letter.from),
      tools: [...searchTools(), ...mcpTools()],
      input: buildMessages(letter, history),
    });
  } catch (error) {
    if (error?.status) throw new Error(`Responses API: ${error.message}`);
    throw error;
  }

  const latencyMs = Math.round(performance.now() - startedAt);
  logToolCalls(response);

  if (response.status === "failed") {
    throw new Error(`Responses API: ${response.error?.message || "запрос завершился с ошибкой"}`);
  }

  const answer = extractText(response);
  if (!answer) {
    throw new Error(`в ответе агента нет текста: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return {
    answer,
    ticketId: extractTicketId(response),
    model: response.model,
    tokensIn: response.usage?.input_tokens ?? 0,
    tokensOut: response.usage?.output_tokens ?? 0,
    latencyMs,
  };
};

module.exports = { askAgent, extractText, buildInput, buildMessages, buildInstructions, extractTicketId };
