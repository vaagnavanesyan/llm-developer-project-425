"use strict";

const { createTransport } = require("./mailer");

// Функция открыта без аутентификации (httpCall из workflow не шлёт IAM-токен),
// поэтому адресат берётся только из окружения: из тела запроса — лишь тема и текст
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 50000;

let transport = null;

const getTransport = () => {
  if (!transport) transport = createTransport();
  return transport;
};

const parseBody = (event) => {
  if (event && typeof event.body === "string") {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    return raw ? JSON.parse(raw) : {};
  }
  return event ?? {};
};

const validate = ({ subject, body }) => {
  if (typeof subject !== "string" || !subject.trim()) throw new RangeError("subject is required");
  if (typeof body !== "string" || !body.trim()) throw new RangeError("body is required");
  if (subject.length > MAX_SUBJECT_LENGTH) throw new RangeError(`subject is longer than ${MAX_SUBJECT_LENGTH}`);
  if (body.length > MAX_BODY_LENGTH) throw new RangeError(`body is longer than ${MAX_BODY_LENGTH}`);
  return { subject: subject.trim(), body };
};

const respond = (statusCode, payload) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(payload),
});

module.exports.handle = async (event) => {
  let letter;
  try {
    letter = validate(parseBody(event));
  } catch (error) {
    return respond(400, { error: error.message });
  }

  try {
    const info = await getTransport().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.OPERATOR_EMAIL,
      subject: letter.subject,
      text: letter.body,
      // Маркер нашего письма: poller не примет дайджест за обращение, если ящики совпадают
      headers: {
        "Auto-Submitted": "auto-generated",
        "X-Helpdesk-Bot": "email-sender",
      },
    });
    console.log(`digest sent messageId=${info.messageId}`);
    return respond(200, { ok: true, messageId: info.messageId });
  } catch (error) {
    console.error(error);
    return respond(500, { error: error.message });
  }
};
