const { randomUUID } = require('node:crypto');
const { Driver, getCredentialsFromEnv, TypedData, TypedValues } = require('ydb-sdk');

const CATEGORIES = ['bug', 'docs', 'feature', 'access'];
const LIST_LIMIT = 50;

// Драйвер живёт между вызовами в рамках одного инстанса функции:
// подключение к YDB дорогое, на каждый вызов его не пересоздаём.
let driverPromise;

function getDriver() {
  if (!driverPromise) {
    driverPromise = (async () => {
      const { YDB_ENDPOINT, YDB_DATABASE } = process.env;
      if (!YDB_ENDPOINT || !YDB_DATABASE) {
        throw new Error('YDB_ENDPOINT and YDB_DATABASE env vars are required');
      }
      // Без спец. переменных окружения SDK берёт IAM-токен сервисного
      // аккаунта функции из metadata-сервиса.
      const driver = new Driver({
        connectionString: `${YDB_ENDPOINT}?database=${YDB_DATABASE}`,
        authService: getCredentialsFromEnv(),
      });
      if (!(await driver.ready(10000))) {
        throw new Error('YDB driver is not ready after 10s');
      }
      return driver;
    })().catch((err) => {
      driverPromise = undefined;
      throw err;
    });
  }
  return driverPromise;
}

async function query(yql, params) {
  const driver = await getDriver();
  return driver.tableClient.withSessionRetry((session) => session.executeQuery(yql, params));
}

function requireString(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${name}" is required`);
  }
  return value.trim();
}

async function createTicket(args) {
  const userId = requireString(args, 'user_id');
  const category = requireString(args, 'category');
  const text = requireString(args, 'text');
  if (!CATEGORIES.includes(category)) {
    throw new Error(`"category" must be one of: ${CATEGORIES.join(', ')}`);
  }

  const id = randomUUID();
  const now = new Date();

  await query(
    `
    DECLARE $id AS Utf8;
    DECLARE $user_id AS Utf8;
    DECLARE $category AS Utf8;
    DECLARE $status AS Utf8;
    DECLARE $text AS Utf8;
    DECLARE $now AS Timestamp;

    INSERT INTO tickets (id, user_id, category, status, text, created_at, updated_at)
    VALUES ($id, $user_id, $category, $status, $text, $now, $now);
    `,
    {
      $id: TypedValues.utf8(id),
      $user_id: TypedValues.utf8(userId),
      $category: TypedValues.utf8(category),
      $status: TypedValues.utf8('open'),
      $text: TypedValues.utf8(text),
      $now: TypedValues.timestamp(now),
    },
  );

  return { ticket_id: id, created_at: now.toISOString() };
}

async function listMyTickets(args) {
  const userId = requireString(args, 'user_id');

  const { resultSets } = await query(
    `
    DECLARE $user_id AS Utf8;

    SELECT id, status, category, text, created_at
    FROM tickets VIEW tickets_by_user
    WHERE user_id = $user_id
    ORDER BY created_at DESC
    LIMIT ${LIST_LIMIT};
    `,
    { $user_id: TypedValues.utf8(userId) },
  );

  if (!resultSets[0]) return [];
  return TypedData.createNativeObjects(resultSets[0]).map((row) => ({
    id: row.id,
    status: row.status,
    category: row.category,
    text: row.text,
    created_at: row.created_at ? row.created_at.toISOString() : null,
  }));
}

const ACTIONS = {
  'create-ticket': createTicket,
  'list-my-tickets': listMyTickets,
};

// Три источника события:
// - прямой invoke: аргументы прямо в event (можно указать action явно);
// - HTTP через API Gateway: тот же JSON строкой в event.body;
// - MCP Hub: аргументы инструмента прямо в event, без action.
function parseArgs(event) {
  if (event && typeof event.body === 'string') {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return raw ? JSON.parse(raw) : {};
  }
  return event ?? {};
}

// MCP Hub не сообщает, какой инструмент вызван, поэтому различаем по ключам:
// у create-ticket есть category/text, у list-my-tickets — только user_id.
function detectAction(args) {
  if (args.action) return args.action;
  if ('category' in args || 'text' in args) return 'create-ticket';
  if ('user_id' in args) return 'list-my-tickets';
  return undefined;
}

module.exports.handler = async (event) => {
  const isHttp = Boolean(event && event.httpMethod);
  let status = 200;
  let result;

  try {
    const args = parseArgs(event);
    const name = detectAction(args);
    const action = ACTIONS[name];
    if (!action) {
      status = 400;
      result = { error: `unknown action "${name}", expected: ${Object.keys(ACTIONS).join(', ')}` };
    } else {
      result = await action(args);
    }
  } catch (err) {
    console.error(err);
    status = err instanceof SyntaxError || /is required|must be one of/.test(err.message) ? 400 : 500;
    result = { error: err.message };
  }

  if (!isHttp) {
    if (status !== 200) throw new Error(result.error);
    return result;
  }
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(result),
  };
};
