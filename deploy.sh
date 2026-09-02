#!/usr/bin/env bash
set -euo pipefail

# В архив кладём код и package.json в корень: зависимости Yandex Cloud
# устанавливает сама на этапе сборки версии функции.
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
PKG_DIR="$BUILD_DIR/package"
ARCHIVE="$BUILD_DIR/email-poller.zip"

mkdir -p "$PKG_DIR"
cp src/email_poller.js package.json package-lock.json "$PKG_DIR/"
(cd "$PKG_DIR" && zip -qr "$ARCHIVE" .)

yc serverless function version create \
  --function-name email-poller \
  --runtime nodejs22 \
  --entrypoint email_poller.handle \
  --memory 256m \
  --execution-timeout 120s \
  --source-path "$ARCHIVE" \
  --service-account-id ajesu29pdo3ql3ug9die \
  --environment YC_FOLDER_ID=b1gg3l0ck2ak3oehfprk,IMAP_HOST=imap.mail.ru,IMAP_USER=vahagn_1993@mail.ru,SMTP_HOST=smtp.mail.ru,SMTP_PORT=465,SMTP_USER=vahagn_1993@mail.ru,HELPDESK_MAILBOX=vahagn_1993@mail.ru \
  --secret environment-variable=IMAP_PASSWORD,name=email-credentials,key=password \
  --secret environment-variable=SMTP_PASSWORD,name=email-credentials,key=password
