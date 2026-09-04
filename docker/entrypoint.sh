#!/bin/sh
# NHP-BACKEND runtime entrypoint.
#
# On every start:
#   1. prisma migrate deploy  (idempotent — noop when up-to-date)
#   2. prisma harden          (roles + triggers, guarded IF NOT EXISTS — re-runnable)
#   3. prisma seed            (reference data — counties, all 293 sub-counties,
#                              ICD-11 diagnoses, KEML medications, symptoms and
#                              triage rules. The CSVs are vendored into
#                              apps/api/prisma/seed-data, so they ship in the
#                              image; the loader no longer depends on a sibling
#                              repo that a container does not have.)
#   4. ministry:bootstrap     (first SUPER_ADMIN — only when NHP_ADMIN_* env vars
#                              are set; refuses on second run, so re-running is
#                              a noop after the first success)
#   5. exec Fastify.
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

echo "[entrypoint] prisma seed (reference data)"
# Non-fatal, and kept that way deliberately. The CSVs now ship in the image,
# so the common cause of a partial seed is gone — but a cold DB with no
# reference data is still a much worse failure than a partial one, and a
# crash-loop on a bad row would take the whole API down with it.
if ! pnpm --filter @nhp/api seed; then
  echo "[entrypoint] seed exited non-zero — continuing (partial seed is preferable to crash-loop)"
fi

# ─── first-run admin bootstrap ────────────────────────────────────────
# Ministry accounts are issued, not self-registered, so the first SUPER_ADMIN
# has to come from outside the app. bootstrap-admin.ts refuses when one
# already exists, which makes this safe to leave in the boot path forever:
# post-first-success it's a fast noop.
#
# The single-use temporary password is written to /tmp inside the container
# instead of stdout — a random credential landing in a deploy log or docker
# logs stays discoverable for weeks. Retrieve with:
#     docker exec nhp-api-1 cat /tmp/nhp-admin-bootstrap.log
if [ -n "${NHP_ADMIN_PHONE:-}" ] && [ -n "${NHP_ADMIN_ID:-}" ] \
   && [ -n "${NHP_ADMIN_GIVEN:-}" ] && [ -n "${NHP_ADMIN_FAMILY:-}" ] \
   && [ -n "${NHP_ADMIN_COUNTY:-}" ]; then
  echo "[entrypoint] ministry:bootstrap (idempotent — refuses when SUPER_ADMIN exists)"
  if pnpm --filter @nhp/api ministry:bootstrap -- \
       --phone  "$NHP_ADMIN_PHONE"  \
       --id     "$NHP_ADMIN_ID"     \
       --given  "$NHP_ADMIN_GIVEN"  \
       --family "$NHP_ADMIN_FAMILY" \
       --county "$NHP_ADMIN_COUNTY" \
       > /tmp/nhp-admin-bootstrap.log 2>&1; then
    echo "[entrypoint] SUPER_ADMIN created — retrieve one-time password with:"
    echo "  docker exec nhp-api-1 cat /tmp/nhp-admin-bootstrap.log"
  else
    # Refusal is the common case on redeploys — script exits 1 when a
    # SUPER_ADMIN already exists, which is exactly the outcome we want.
    echo "[entrypoint] ministry:bootstrap noop (SUPER_ADMIN already exists or seed county missing)"
  fi
else
  echo "[entrypoint] NHP_ADMIN_* not set — skipping first-run admin bootstrap"
fi

echo "[entrypoint] starting: $*"
exec "$@"
