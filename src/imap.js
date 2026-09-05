"use strict";

const { ImapFlow } = require("imapflow");

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
    // Дефолты библиотеки (до 90 с на коннект) съели бы весь лимит функции в 120 с
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 90000,
  });

const findFolderPath = async (client, folderName) => {
  const mailboxes = await client.list();
  const wanted = folderName.toLowerCase();
  const mailbox =
    mailboxes.find((box) => box.path.toLowerCase() === wanted) ||
    mailboxes.find((box) => box.name.toLowerCase() === wanted);

  if (!mailbox) {
    const available = mailboxes.map((box) => box.path).join(", ");
    throw new Error(`папка "${folderName}" не найдена. Доступные папки: ${available}`);
  }

  return mailbox.path;
};

const openFolder = async (client, folderName) => {
  const folder = await findFolderPath(client, folderName);
  await client.mailboxOpen(folder);
  return folder;
};

const fetchUnseenUids = async (client, limit) => {
  const uids = (await client.search({ seen: false }, { uid: true })) || [];
  return uids.slice(0, limit);
};

// Дешёвый проход по метаданным: у функции всего 256 МБ, гигантские письма не тянем в память
const fetchSizes = async (client, uids) => {
  if (uids.length === 0) return [];
  return (await client.fetchAll(uids, { uid: true, size: true }, { uid: true })) || [];
};

// source приходит через BODY.PEEK[], поэтому письмо не помечается прочитанным
const fetchMessage = (client, uid) =>
  client.fetchOne(String(uid), { source: true }, { uid: true });

const markSeen = (client, uid) => client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });

module.exports = {
  createClient,
  findFolderPath,
  openFolder,
  fetchUnseenUids,
  fetchSizes,
  fetchMessage,
  markSeen,
};
