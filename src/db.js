"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { Driver, getCredentialsFromEnv, TypedData, TypedValues } = require("ydb-sdk");

const DRIVER_TIMEOUT_MS = 10000;

// Драйвер переиспользуется между вызовами в рамках одного инстанса функции
let driverPromise = null;

const getDriver = () => {
  if (!driverPromise) {
    driverPromise = (async () => {
      const { YDB_ENDPOINT, YDB_DATABASE } = process.env;
      // Без спец. переменных окружения SDK берёт IAM-токен сервисного
      // аккаунта функции из metadata-сервиса
      const driver = new Driver({
        connectionString: `${YDB_ENDPOINT}?database=${YDB_DATABASE}`,
        authService: getCredentialsFromEnv(),
      });
      if (!(await driver.ready(DRIVER_TIMEOUT_MS))) {
        throw new Error(`YDB: драйвер не подключился за ${DRIVER_TIMEOUT_MS} мс`);
      }
      return driver;
    })().catch((error) => {
      driverPromise = null;
      throw error;
    });
  }
  return driverPromise;
};

const query = async (yql, params) => {
  const driver = await getDriver();
  return driver.tableClient.withSessionRetry((session) => session.executeQuery(yql, params));
};

// Письмо, упавшее на вызове LLM, не помечается прочитанным и придёт снова.
// Id из Message-ID делает запись входящего идемпотентной (UPSERT перезапишет ту же строку).
const userMessageId = (messageId) => {
  if (!messageId) return randomUUID();
  const hex = createHash("sha256").update(messageId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

// Последние реплики пользователя — от старых к новым
const loadHistory = async (userId, limit) => {
  const { resultSets } = await query(
    `
    DECLARE $user_id AS Utf8;
    DECLARE $limit AS Uint64;

    SELECT id, role, text, created_at
    FROM messages
    WHERE user_id = $user_id
    ORDER BY created_at DESC
    LIMIT $limit;
    `,
    { $user_id: TypedValues.utf8(userId), $limit: TypedValues.uint64(limit) },
  );

  if (!resultSets[0]) return [];
  return TypedData.createNativeObjects(resultSets[0])
    .map((row) => ({ id: row.id, role: row.role, text: row.text }))
    .reverse();
};

const saveUserMessage = async ({ id, userId, text }) => {
  await query(
    `
    DECLARE $id AS Utf8;
    DECLARE $user_id AS Utf8;
    DECLARE $text AS Utf8;
    DECLARE $now AS Timestamp;

    UPSERT INTO messages (user_id, id, role, text, created_at)
    VALUES ($user_id, $id, "user"u, $text, $now);
    `,
    {
      $id: TypedValues.utf8(id),
      $user_id: TypedValues.utf8(userId),
      $text: TypedValues.utf8(text),
      $now: TypedValues.timestamp(new Date()),
    },
  );
};

const saveAgentMessage = async ({ userId, text, model, tokensIn, tokensOut, latencyMs }) => {
  const id = randomUUID();
  await query(
    `
    DECLARE $id AS Utf8;
    DECLARE $user_id AS Utf8;
    DECLARE $text AS Utf8;
    DECLARE $model AS Utf8;
    DECLARE $tokens_in AS Uint64;
    DECLARE $tokens_out AS Uint64;
    DECLARE $latency_ms AS Uint32;
    DECLARE $now AS Timestamp;

    INSERT INTO messages (user_id, id, role, text, model, tokens_in, tokens_out, latency_ms, created_at)
    VALUES ($user_id, $id, "agent"u, $text, $model, $tokens_in, $tokens_out, $latency_ms, $now);
    `,
    {
      $id: TypedValues.utf8(id),
      $user_id: TypedValues.utf8(userId),
      $text: TypedValues.utf8(text),
      $model: TypedValues.utf8(model || ""),
      $tokens_in: TypedValues.uint64(tokensIn || 0),
      $tokens_out: TypedValues.uint64(tokensOut || 0),
      $latency_ms: TypedValues.uint32(latencyMs || 0),
      $now: TypedValues.timestamp(new Date()),
    },
  );
  return id;
};

// Проставляет ticket_id обеим репликам цикла (UPDATE по PK user_id + id)
const linkTicket = async ({ userId, messageIds, ticketId }) => {
  for (const id of messageIds) {
    await query(
      `
      DECLARE $user_id AS Utf8;
      DECLARE $id AS Utf8;
      DECLARE $ticket_id AS Utf8;

      UPDATE messages SET ticket_id = $ticket_id
      WHERE user_id = $user_id AND id = $id;
      `,
      {
        $user_id: TypedValues.utf8(userId),
        $id: TypedValues.utf8(id),
        $ticket_id: TypedValues.utf8(ticketId),
      },
    );
  }
};

module.exports = { userMessageId, loadHistory, saveUserMessage, saveAgentMessage, linkTicket };
