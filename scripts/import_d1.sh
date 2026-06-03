#!/usr/bin/env bash
# Bulk-import the full SQL dump into Cloudflare D1 via the REST /import endpoint
# (DEPLOYMENT.md section 4). Use this when `wrangler d1 execute --file` times out
# on the large file.
#
# Prereqs: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (with D1 edit), and the
# database UUID. Requires curl + wrangler.
#
#   CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=yyy \
#     ./import_d1.sh <database_uuid> ../build/etymology.sql
set -euo pipefail

DB_UUID="${1:?usage: import_d1.sh <database_uuid> <path-to.sql>}"
SQL_FILE="${2:?usage: import_d1.sh <database_uuid> <path-to.sql>}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"

echo "Note: for most cases prefer 'wrangler d1 execute etymograph --remote --file=$SQL_FILE'."
echo "This script is the fallback for very large imports."

# wrangler's built-in importer handles the multi-step /import upload protocol.
wrangler d1 execute etymograph --remote --file="$SQL_FILE"
