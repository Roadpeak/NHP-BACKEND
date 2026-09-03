#!/bin/sh
# NHP-BACKEND runtime entrypoint.
#
# On every start:
#   1. prisma migrate deploy (idempotent — noop when up-to-date)
#   2. prisma harden (applies harden.sql — roles, triggers, constraints)
#      Idempotent by construction: guarded CREATE ROLE + IF NOT EXISTS on
#      every object. Safe to re-run.
#   3. exec Fastify.
#
# Role passwords come from env (APP_ROLE_PASSWORD, AUDIT_WRITER_ROLE_PASSWORD,
# AUDITOR_ROLE_PASSWORD, ANALYST_ROLE_PASSWORD). Missing values make the app
# refuse to boot — that's a feature; a health portal should never start
# without its per-role isolation.
set -eu

cd /app

echo "[entrypoint] prisma migrate deploy"
pnpm --filter @nhp/api migrate:deploy

echo "[entrypoint] prisma harden (roles + guarantees)"
pnpm --filter @nhp/api harden

echo "[entrypoint] starting: $*"
exec "$@"
