"use strict";

const nodemailer = require("nodemailer");

const createTransport = () =>
  nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 465,
    secure: true, // 465 — TLS сразу при подключении, без STARTTLS
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
    pool: true,
    maxConnections: 1,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });

const buildSubject = (subject) => {
  const original = (subject || "").trim();
  if (!original) return "Re: (без темы)";
  return /^re:/i.test(original) ? original : `Re: ${original}`;
};

// References может прийти строкой с несколькими id через пробел или массивом
const buildReferences = (letter) => {
  const references = []
    .concat(letter.references || [])
    .flatMap((reference) => String(reference).split(/\s+/))
    .filter(Boolean);

  if (letter.messageId && !references.includes(letter.messageId)) {
    references.push(letter.messageId);
  }

  return references.slice(-20);
};

const sendReply = (transport, letter, answer) => {
  const references = buildReferences(letter);

  return transport.sendMail({
    // mail.ru требует, чтобы отправитель совпадал с авторизованным пользователем
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: letter.replyTo || letter.from,
    subject: buildSubject(letter.subject),
    text: answer,
    inReplyTo: letter.messageId || undefined,
    references: references.length > 0 ? references : undefined,
    // Маркеры автоответа: чужие автоответчики не зациклятся, а свой ответ мы узнаем по X-Helpdesk-Bot
    headers: {
      "Auto-Submitted": "auto-replied",
      "X-Auto-Response-Suppress": "All",
      "X-Helpdesk-Bot": "email-poller",
    },
  });
};

module.exports = { createTransport, sendReply, buildSubject, buildReferences };
