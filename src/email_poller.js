"use strict";

const { ImapFlow } = require("imapflow");

const REQUIRED_ENV = ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD"];
const DEFAULT_FOLDER = "llm-developer@mail.ru"; // Отдельная папка, чтобы не читать всю личную почту

const createClient = () =>
  new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT) || 993,
    secure: true,
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASSWORD,
    },
    logger: process.env.IMAP_DEBUG === "true" ? console : false,
    // mail.ru ожидает, что сторонний клиент представится через IMAP-команду ID
    clientInfo: { name: "email-poller", vendor: "llm-developer-project-425" },
  });

const findFolderPath = async (client, folderName) => {
  const mailboxes = await client.list();
  const wanted = folderName.toLowerCase();
  const mailbox =
    mailboxes.find((box) => box.path.toLowerCase() === wanted) ||
    mailboxes.find((box) => box.name.toLowerCase() === wanted);

  if (!mailbox) {
    const available = mailboxes.map((box) => box.path).join(", ");
    throw new Error(
      `папка "${folderName}" не найдена. Доступные папки: ${available}`,
    );
  }

  return mailbox.path;
};

const countUnread = async (folderName) => {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`не заданы переменные окружения: ${missing.join(", ")}`);
  }

  const client = createClient();
  client.on("error", (error) =>
    console.error(`Ошибка IMAP-соединения: ${error.message}`),
  );
  await client.connect();

  try {
    const folder = await findFolderPath(client, folderName);
    const status = await client.status(folder, {
      unseen: true,
      messages: true,
    });
    return { folder, unread: status.unseen, total: status.messages };
  } finally {
    await client.logout().catch(() => client.close());
  }
};

module.exports.handle = async () => {
  const folderName = process.env.IMAP_FOLDER || DEFAULT_FOLDER;

  try {
    const result = await countUnread(folderName);
    console.log(
      `Папка "${result.folder}": непрочитанных писем — ${result.unread}, всего — ${result.total}`,
    );
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, ...result }),
    };
  } catch (error) {
    console.error(
      `Не удалось получить количество непрочитанных писем: ${error.message}`,
    );
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        folder: folderName,
        error: error.message,
      }),
    };
  }
};

if (require.main === module) {
  module.exports.handle().then((response) => console.log(response.body));
}
