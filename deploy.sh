#!/usr/bin/env bash
set -euo pipefail

# Использование: ./deploy.sh [email-poller|ydb-tickets|mcp-gateway]  (по умолчанию email-poller)
TARGET="${1:-email-poller}"

FOLDER_ID=b1gg3l0ck2ak3oehfprk
SA_ID=ajesu29pdo3ql3ug9die # ai-studio-sa
MCP_GATEWAY_NAME=ydb-tickets-mcp
YDB_SECRETS=(
  --secret environment-variable=YDB_ENDPOINT,name=ydb-endpoint,key=value
  --secret environment-variable=YDB_DATABASE,name=ydb-database,key=value
)

# В архив кладём код и package.json в корень: зависимости Yandex Cloud
# устанавливает сама на этапе сборки версии функции.
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
PKG_DIR="$BUILD_DIR/package"
ARCHIVE="$BUILD_DIR/$TARGET.zip"
mkdir -p "$PKG_DIR"

pack() {
  (cd "$PKG_DIR" && zip -qr "$ARCHIVE" .)
}

deploy_email_poller() {
  cp src/*.js package.json package-lock.json "$PKG_DIR/"
  pack

  local mcp_url
  mcp_url="$(yc serverless mcp-gateway get --name "$MCP_GATEWAY_NAME" --folder-id "$FOLDER_ID" --format json | jq -r '.base_domain')/sse"

  yc serverless function version create \
    --function-name email-poller \
    --folder-id "$FOLDER_ID" \
    --runtime nodejs22 \
    --entrypoint email_poller.handle \
    --memory 256m \
    --execution-timeout 120s \
    --source-path "$ARCHIVE" \
    --service-account-id "$SA_ID" \
    --environment YC_FOLDER_ID=$FOLDER_ID,IMAP_HOST=imap.mail.ru,IMAP_USER=vahagn_1993@mail.ru,SMTP_HOST=smtp.mail.ru,SMTP_PORT=465,SMTP_USER=vahagn_1993@mail.ru,HELPDESK_MAILBOX=vahagn_1993@mail.ru,AI_MODEL=deepseek-v4.1-flash/latest,DRY_RUN=false,MAX_MESSAGES=5,MCP_TICKETS_URL="$mcp_url" \
    --secret environment-variable=IMAP_PASSWORD,name=email-credentials,key=password \
    --secret environment-variable=SMTP_PASSWORD,name=email-credentials,key=password \
    --secret environment-variable=AI_API_KEY,name=ai-studio-api-key,key=value \
    "${YDB_SECRETS[@]}"
}

deploy_ydb_tickets() {
  cp src/ydb-tickets/index.js src/ydb-tickets/package.json src/ydb-tickets/package-lock.json "$PKG_DIR/"
  pack

  yc serverless function version create \
    --function-name ydb-tickets \
    --folder-id "$FOLDER_ID" \
    --runtime nodejs22 \
    --entrypoint index.handler \
    --memory 256m \
    --execution-timeout 30s \
    --source-path "$ARCHIVE" \
    --service-account-id "$SA_ID" \
    "${YDB_SECRETS[@]}"
}

# Подставляет ID функции ydb-tickets в mcp-tools.yaml и создаёт шлюз
# (или обновляет список инструментов, если шлюз уже есть).
deploy_mcp_gateway() {
  local function_id tools_file
  function_id="$(yc serverless function get --name ydb-tickets --folder-id "$FOLDER_ID" --format json | jq -r .id)"
  tools_file="$BUILD_DIR/mcp-tools.yaml"
  sed "s/<CF_ID>/$function_id/g" src/ydb-tickets/mcp-tools.yaml > "$tools_file"

  if yc serverless mcp-gateway get --name "$MCP_GATEWAY_NAME" --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
    yc serverless mcp-gateway update "$MCP_GATEWAY_NAME" --folder-id "$FOLDER_ID" --tools-file "$tools_file"
  else
    yc serverless mcp-gateway create \
      --name "$MCP_GATEWAY_NAME" \
      --folder-id "$FOLDER_ID" \
      --service-account-id "$SA_ID" \
      --tools-file "$tools_file"
  fi
}

case "$TARGET" in
  email-poller) deploy_email_poller ;;
  ydb-tickets) deploy_ydb_tickets ;;
  mcp-gateway) deploy_mcp_gateway ;;
  *) echo "неизвестная цель: $TARGET" >&2; exit 1 ;;
esac
