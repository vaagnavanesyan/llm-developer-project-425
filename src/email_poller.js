"use strict";

const { simpleParser } = require("mailparser");
const { convert } = require("html-to-text");

const { createClient, openFolder, fetchUnseenUids, fetchSizes, fetchMessage, markSeen } = require("./imap");
const { askAgent } = require("./ai");
const { createTransport, sendReply } = require("./mailer");

const REQUIRED_ENV = [
  "IMAP_HOST",
  "IMAP_USER",
  "IMAP_PASSWORD",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "AI_API_KEY",
  "AI_AGENT_ID",
];
const DEFAULT_FOLDER = "llm-developer@mail.ru"; // Отдельная папка, чтобы не читать всю личную почту
const DEFAULT_MAX_MESSAGES = 5;
const DEFAULT_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_BODY_CHARS = 8000;
// Запас до таймаута функции: хватит на текущее письмо, logout и сводку
const RESERVE_MS = 25000;
const LOCAL_BUDGET_MS = 110000;
const NO_REPLY_SENDER = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster)@/i;

// Отправлять письма по-настоящему нужно попросить явно: DRY_RUN=false
const isDryRun = () => process.env.DRY_RUN !== "false";

const envNumber = (name, fallback) => Number(process.env[name]) || fallback;

// В облаке остаток времени знает сам рантайм, локально берём условный бюджет
const deadlineFrom = (context) => {
  const remaining =
    typeof context?.getRemainingTimeInMillis === "function"
      ? context.getRemainingTimeInMillis()
      : LOCAL_BUDGET_MS;
  return Date.now() + Math.max(remaining - RESERVE_MS, 0);
};

const extractText = (parsed) => {
  const plain = (parsed.text || "").trim();
  const html = parsed.html
    ? convert(parsed.html, {
        wordwrap: false,
        selectors: [
          { selector: "a", options: { ignoreHref: true } },
          { selector: "img", format: "skip" },
        ],
      }).trim()
    : "";

  return (plain || html)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, envNumber("MAX_BODY_CHARS", DEFAULT_MAX_BODY_CHARS));
};

const toLetter = (parsed) => ({
  from: parsed.from?.value?.[0]?.address || "",
  // По RFC отвечать нужно на Reply-To, если он задан
  replyTo: parsed.replyTo?.value?.[0]?.address || "",
  subject: parsed.subject || "",
  text: extractText(parsed),
  messageId: parsed.messageId || "",
  references: [].concat(parsed.references || []),
  headers: parsed.headers,
});

const headerValue = (letter, name) => {
  const raw = letter.headers?.get(name);
  if (!raw) return "";
  return String(typeof raw === "object" && "value" in raw ? raw.value : raw);
};

// Причина, по которой на письмо не нужно отвечать (null — отвечаем)
const skipReason = (letter) => {
  const ownAddresses = [process.env.HELPDESK_MAILBOX, process.env.SMTP_USER, process.env.IMAP_USER]
    .filter(Boolean)
    .map((address) => address.toLowerCase());
  const autoSubmitted = headerValue(letter, "auto-submitted").trim().toLowerCase();
  const sender = letter.replyTo || letter.from;

  if (!sender) return "не удалось определить отправителя";
  if (ownAddresses.includes(sender.toLowerCase())) return "письмо от самого себя";
  if (NO_REPLY_SENDER.test(sender)) return "адрес отправителя не принимает ответы";
  if (autoSubmitted && autoSubmitted !== "no") return "письмо само является автоответом";
  if (letter.headers?.has("x-helpdesk-bot")) return "это наш собственный автоответ";
  if (letter.headers?.has("x-auto-response-suppress")) return "отправитель просит не отвечать автоматом";
  if (/bulk|list|junk/i.test(headerValue(letter, "precedence"))) return "массовая рассылка";
  if (letter.headers?.has("list-id") || letter.headers?.has("list-unsubscribe")) return "рассылка";
  if (!letter.text) return "в письме нет текста";

  return null;
};

const skipMessage = async ({ client, uid, reason, stats, dryRun }) => {
  stats.skipped += 1;
  console.log(`UID ${uid}: пропускаем — ${reason}`);
  // Помечаем прочитанным, иначе такое письмо будет всплывать в каждой выборке
  if (!dryRun) await markSeen(client, uid);
};

const processMessage = async ({ client, transport, uid, size, stats, dryRun }) => {
  const maxBytes = envNumber("MAX_MESSAGE_BYTES", DEFAULT_MAX_MESSAGE_BYTES);
  if (size > maxBytes) {
    await skipMessage({ client, uid, reason: `письмо больше ${maxBytes} байт`, stats, dryRun });
    return;
  }

  const message = await fetchMessage(client, uid);
  if (!message) {
    throw new Error("письмо не найдено (возможно, удалено между выборкой и чтением)");
  }

  const letter = toLetter(await simpleParser(message.source));
  const reason = skipReason(letter);
  if (reason) {
    await skipMessage({ client, uid, reason, stats, dryRun });
    return;
  }

  console.log(`UID ${uid}: письмо от ${letter.from}, тема "${letter.subject}"`);
  const answer = await askAgent(letter);
  stats.answered += 1;

  if (dryRun) {
    console.log(`UID ${uid}: DRY_RUN, письмо не отправлено. Ответ агента:\n${answer.slice(0, 500)}`);
    return;
  }

  await sendReply(transport, letter, answer);
  stats.sent += 1;
  console.log(`UID ${uid}: ответ отправлен на ${letter.replyTo || letter.from}`);

  // Флаг ставим последним: если отправка упала, письмо попадёт в следующую выборку
  try {
    await markSeen(client, uid);
  } catch (error) {
    console.error(
      `UID ${uid}: ответ отправлен, но флаг \\Seen не проставлен (${error.message}) — на следующем запуске письмо получит ответ повторно`,
    );
  }
};

const processMailbox = async (context) => {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`не заданы переменные окружения: ${missing.join(", ")}`);
  }

  const folderName = process.env.IMAP_FOLDER || DEFAULT_FOLDER;
  const limit = envNumber("MAX_MESSAGES", DEFAULT_MAX_MESSAGES);
  const dryRun = isDryRun();
  const deadline = deadlineFrom(context);
  const stats = { unseen: 0, answered: 0, sent: 0, skipped: 0, failed: 0, stoppedByDeadline: false };

  const client = createClient();
  client.on("error", (error) => console.error(`Ошибка IMAP-соединения: ${error.message}`));
  await client.connect();

  let transport = null;
  let folder = folderName;

  try {
    folder = await openFolder(client, folderName);
    const uids = await fetchUnseenUids(client, limit);
    stats.unseen = uids.length;
    console.log(
      `Папка "${folder}": непрочитанных к обработке — ${uids.length} (лимит ${limit}, DRY_RUN=${dryRun})`,
    );

    const sizes = new Map((await fetchSizes(client, uids)).map((item) => [item.uid, item.size]));
    if (!dryRun && uids.length > 0) transport = createTransport();

    for (const uid of uids) {
      if (Date.now() > deadline) {
        stats.stoppedByDeadline = true;
        console.warn("Лимит времени запуска исчерпан, остальные письма обработаем в следующий раз");
        break;
      }

      try {
        await processMessage({ client, transport, uid, size: sizes.get(uid) || 0, stats, dryRun });
      } catch (error) {
        stats.failed += 1;
        console.error(`UID ${uid}: ошибка обработки — ${error.message}`);
      }
    }
  } finally {
    if (transport) transport.close();
    await client.logout().catch(() => client.close());
  }

  return { folder, dryRun, ...stats };
};

module.exports.handle = async (event, context) => {
  try {
    const result = await processMailbox(context);
    console.log(
      `Итог: обработано ${result.unseen}, ответов от агента ${result.answered}, отправлено ${result.sent}, пропущено ${result.skipped}, с ошибкой ${result.failed}`,
    );
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, ...result }),
    };
  } catch (error) {
    console.error(`Не удалось обработать почту: ${error.message}`);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: error.message }),
    };
  }
};

if (require.main === module) {
  module.exports.handle().then((response) => console.log(response.body));
}
