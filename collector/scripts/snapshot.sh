#!/usr/bin/env bash
#
# Take a verified copy of the collected data over HTTP, into a synced folder.
#
# This exists alongside backup.sh for one reason: backup.sh needs the Postgres
# client tools and the database's external connection string, and neither is
# installed on the machine that actually needs to hold the backup. This needs
# curl and nothing else, so it runs today rather than after an afternoon of
# installing Homebrew.
#
# It is a WEAKER backup than backup.sh and that is an honest trade. The API
# serves the views, not the tables, so a restore from these files would have to
# be reconstructed rather than loaded. What it does give you is the thing that
# matters most: a copy of the numbers, outside Render, on a machine you own and
# in a folder that syncs to cloud storage. This dataset cannot be rebuilt —
# whatever was not recorded as it happened is gone — so a partial copy that
# exists beats a perfect copy that does not.
#
# Like backup.sh, it refuses to report success on a file it has not read back.
# A 502 from a sleeping service is 150 bytes of HTML and looks exactly like a
# backup from the outside.
#
# Usage:
#   ./scripts/snapshot.sh                 # into ~/OneDrive/gods-eye-view-data
#   ./scripts/snapshot.sh /some/other/dir
#
# Re-run it whenever you like. Each run writes its own dated folder, so running
# it twice never overwrites a copy — it adds one.

set -euo pipefail

BASE="${COLLECTOR_URL:-https://chokepoint-collector.onrender.com}"
ROOT="${1:-$HOME/OneDrive/gods-eye-view-data}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
OUT="${ROOT}/${STAMP}"

# 90 days and 5000 rows are the endpoint's own ceilings. Asking for the maximum
# every time means a snapshot is always the whole record, so no single file is
# ever a partial one that has to be stitched to another to be read.
HOURS=2160
LIMIT=5000

command -v curl >/dev/null 2>&1 || { echo "curl not found." >&2; exit 1; }

mkdir -p "$OUT"
echo "==> ${OUT}"
echo

FAILED=0

# fetch <filename> <path-with-query> <sentinel-key> <row-key>
#
# `sentinel` is a key the response MUST contain. Checking only the HTTP status
# would accept a 200 carrying {"error":"query failed"}, which is the API doing
# exactly what it should and still not being data.
fetch() {
  local name="$1" path="$2" sentinel="$3" rowkey="$4"
  local file="${OUT}/${name}" code why
  why="${OUT}/.curl-stderr"

  printf '  %-18s ' "$name"
  # --max-time is generous because a Render service that has been idle can take
  # the better part of a minute to answer its first request.
  #
  # curl prints 000 and exits non-zero when nothing answered at all, so the
  # status is read on its own line rather than through `|| echo` — which would
  # otherwise concatenate two codes into one unreadable string.
  # curl's own message is kept but held back, so it lands inside the aligned
  # status line instead of jumping ahead of it. "could not connect" and "timed
  # out" need different fixes and the HTTP code alone cannot tell them apart.
  code="$(curl --silent --show-error --location --max-time 120 \
    --write-out '%{http_code}' --output "$file" "${BASE}${path}" 2>"$why")" || code=000

  if [[ "$code" != "200" ]]; then
    echo "FAILED (HTTP ${code}) $(tr -d '\n' < "$why" 2>/dev/null || true)"
    FAILED=1
    return
  fi
  if ! grep -q "\"${sentinel}\"" "$file" 2>/dev/null; then
    echo "FAILED (answered, but no \"${sentinel}\" in it)"
    FAILED=1
    return
  fi

  # One occurrence of the row key per row. Crude, exact for these payloads, and
  # it needs no JSON parser — which is the whole point of this script.
  #
  # `|| true` is load-bearing. grep exits 1 when it matches nothing, and under
  # `set -o pipefail` that aborts the whole script — so an airspace with no
  # contacts yet, which is the normal state, would kill the backup. Zero rows
  # is an answer, not an error.
  local rows bytes
  rows="$( { grep -o "\"${rowkey}\":" "$file" || true; } | wc -l | tr -d ' ')"
  # Bytes rather than `du -h`: du rounds up to the block size, so a 150-byte
  # error page and a real file both read as "4.0K".
  bytes="$(wc -c < "$file" | tr -d ' ')"
  echo "ok  ${rows} rows, ${bytes} bytes"
}

fetch crossings.json   "/crossings?hours=${HOURS}&limit=${LIMIT}" rows        chokepoint
fetch hours.json       "/hours?hours=${HOURS}"                    coverage    chokepoint
fetch days.json        "/days?hours=${HOURS}"                     rows        chokepoint
fetch gaps.json        "/gaps?hours=${HOURS}&limit=2000"          rows        mmsi
fetch air.json         "/air?hours=${HOURS}"                      airspaces   airspace
fetch diagnostics.json "/diagnostics"                             chokepoints id
fetch health.json      "/health"                                  rulesVersion ok

rm -f "${OUT}/.curl-stderr"

echo
if [[ "$FAILED" -ne 0 ]]; then
  echo "==> INCOMPLETE. At least one file above is not data." >&2
  echo "    The folder is kept so you can see which. Fix and re-run;" >&2
  echo "    a later run never overwrites an earlier one." >&2
  exit 1
fi

cat > "${ROOT}/README.txt" <<'TXT'
God's Eye View — chokepoint collector data
==========================================

Each dated folder is a complete snapshot taken straight from the live
service. Nothing here is derived or edited.

WHY IT MATTERS THAT THESE EXIST
  This data cannot be rebuilt. It is a record of where ships were at a
  moment that has passed; no API sells the history back. If the Render
  database is lost, whatever is in these folders is what remains.

WHAT IS IN A SNAPSHOT
  crossings.json    One row per ship crossing a gate. The raw record.
  hours.json        Hourly counts, with the message and vessel counts
                    that say whether a zero means no ships or no signal.
  days.json         The same, rolled up per day.
  gaps.json         Vessels that went silent, classified dark or spoofed.
  air.json          Military aircraft contacts, if OpenSky is working.
  diagnostics.json  What the feed could actually see at that moment.
  health.json       Service state and the rules version in force.

READING IT LATER
  Never read a count without its denominator. `messages` and `vessels`
  in hours.json are what separate a quiet strait from a dead antenna,
  and `observed` says whether the collector was even running.

  `rulesVersion` marks the detection rules. Rows stamped r3 and r4 were
  produced by different gate geometry and are not directly comparable.

  Bosphorus crossings are NOT a traffic series — they measure reception.
  From r4 on, every response says so in its `transitSeries` field.

  queue_depth before migration 005 tracked reception, not the anchorage.
  Use queue_share where it exists; ignore the bare depth where it does not.

TO TAKE ANOTHER
  Run collector/scripts/snapshot.sh from the repository. It adds a new
  dated folder and never touches the ones already here.
TXT

COUNT="$(find "$ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
echo "==> OK  ${COUNT} snapshot(s) in ${ROOT}"
echo
echo "If that path is inside OneDrive, it is uploading now. Check for the"
echo "green tick in Finder before you close the laptop — a file that has"
echo "not finished syncing is still only on this machine."
