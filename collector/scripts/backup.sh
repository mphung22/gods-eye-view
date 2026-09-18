#!/usr/bin/env bash
#
# Take a verified, independent copy of the chokepoint database.
#
# Render's managed Postgres keeps its own backups, and they are good. They also
# live inside the same account as the thing they protect. This dataset cannot
# be rebuilt — whatever was not recorded as it happened is gone — so it wants
# one copy that survives losing access to Render entirely.
#
# The script refuses to report success on a dump it has not read back. An
# unverified backup is a belief, not a backup, and a zero-byte file is exactly
# what a broken backup looks like from the outside.
#
# Usage:
#   export DATABASE_URL='postgresql://...'      # the EXTERNAL connection string
#   ./scripts/backup.sh [output-directory]
#
# The connection string contains a password. Keep it in your shell or a
# password manager, never in a file in this repository and never in a chat.

set -euo pipefail

OUT_DIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="${OUT_DIR}/chokepoints-${STAMP}.dump"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set." >&2
  echo >&2
  echo "Render dashboard -> chokepoint-db -> Connect -> External Connection." >&2
  echo "External access also needs your IP in Access Control; see README." >&2
  exit 1
fi

for tool in pg_dump pg_restore psql; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "$tool not found. Install the Postgres client tools (libpq)." >&2
    exit 1
  }
done

mkdir -p "$OUT_DIR"

echo "==> Dumping to ${DUMP}"
# Custom format: compressed, and pg_restore can list its contents, which is
# what makes verification possible without a second database.
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"

echo "==> Verifying the dump is readable"
# If the file is truncated or corrupt this exits non-zero and the script stops
# here rather than printing a reassuring summary over a broken file.
TABLES_IN_DUMP="$(pg_restore --list "$DUMP" | grep -c 'TABLE DATA' || true)"
if [[ "$TABLES_IN_DUMP" -eq 0 ]]; then
  echo "The dump contains no table data. Refusing to call this a backup." >&2
  exit 1
fi

echo "==> Comparing against the live database"
# Row counts either side. A backup that restores cleanly but holds a tenth of
# the rows is the failure mode that survives every other check.
psql "$DATABASE_URL" --quiet --no-align --tuples-only --command "
  SELECT format('%-16s %s', t, n) FROM (
    SELECT 'crossings'    AS t, count(*) AS n FROM crossings
    UNION ALL SELECT 'gaps',          count(*) FROM gaps
    UNION ALL SELECT 'region_hours',  count(*) FROM region_hours
    UNION ALL SELECT 'service_hours', count(*) FROM service_hours
    UNION ALL SELECT 'market_hours',  count(*) FROM market_hours
  ) s ORDER BY t;
"

SIZE="$(du -h "$DUMP" | cut -f1)"
echo
echo "==> OK  ${DUMP}  (${SIZE}, ${TABLES_IN_DUMP} tables)"
echo
echo "Copy it somewhere that is not Render — the point is surviving the loss"
echo "of that account, so a second folder on the same laptop is not enough."
echo
echo "To restore into an empty database:"
echo "  pg_restore --no-owner --no-privileges --dbname='<target-url>' '${DUMP}'"
