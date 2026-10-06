# Take a verified copy of the collected data into OneDrive, on Windows.
#
# The PowerShell twin of snapshot.sh. Same job, same rule: never report success
# on a file it has not read back. See that script's header for why an HTTP
# snapshot exists alongside the pg_dump one at all.
#
# Written for Windows PowerShell 5.1, which is what ships with Windows and so
# what this will actually be run on. That rules out PowerShell 7 conveniences
# -- no ternaries, no null-coalescing, no -SkipHttpErrorCheck -- and requires
# -UseBasicParsing and an explicit TLS 1.2, because 5.1 still negotiates TLS
# 1.0 first and Render refuses it.
#
# Usage, from a PowerShell window:
#   .\scripts\snapshot.ps1
#   .\scripts\snapshot.ps1 -Root 'D:\somewhere\else'
#
# Re-run it whenever. Each run writes its own dated folder, so running it twice
# never overwrites a copy -- it adds one.

[CmdletBinding()]
param(
  [string]$Root,
  [string]$Base = $(if ($env:COLLECTOR_URL) { $env:COLLECTOR_URL } else { 'https://chokepoint-collector.onrender.com' })
)

$ErrorActionPreference = 'Stop'

# 5.1 negotiates TLS 1.0 first and gets hung up on. Harmless on 7.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 90 days and 5000 rows are the endpoint's own ceilings. Asking for the maximum
# every time means a snapshot is always the whole record, so no single file is
# ever a partial one that has to be stitched to another to be read.
$HoursWindow = 2160
$RowLimit    = 5000

# --- Where to write -------------------------------------------------------
#
# $env:OneDrive is set by the sync client itself, so it is the only answer that
# knows about a renamed folder or a business tenant. The guesses after it are
# guesses, and the existence check below is what stops a wrong one quietly
# creating an ordinary local folder that never syncs anywhere -- which would
# look exactly like a working backup until the day the laptop died.
if (-not $Root) {
  $candidates = @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)
  # Guarded: Join-Path throws on a null first argument rather than returning
  # nothing, so an unset USERPROFILE took down the whole script before it
  # reached the much friendlier "could not find OneDrive" message below.
  if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE 'OneDrive') }
  $oneDrive = $null
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Container)) { $oneDrive = $c; break }
  }
  if (-not $oneDrive) {
    Write-Host 'Could not find your OneDrive folder.' -ForegroundColor Red
    Write-Host ''
    Write-Host 'Nothing was written. A backup in a folder that does not sync is'
    Write-Host 'not a backup, so this stops rather than guessing a path.'
    Write-Host ''
    Write-Host 'Open File Explorer, find OneDrive in the sidebar, copy its full'
    Write-Host 'path from the address bar, and run:'
    Write-Host '  .\scripts\snapshot.ps1 -Root "C:\Users\you\OneDrive\gods-eye-view-data"'
    exit 1
  }
  $Root = Join-Path $oneDrive 'gods-eye-view-data'
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHHmmss'Z'")
$out   = Join-Path $Root $stamp
New-Item -ItemType Directory -Path $out -Force | Out-Null

Write-Host "==> $out"
Write-Host ''

$script:Failed = 0

function Get-Snapshot {
  param(
    [string]$Name,     # file to write
    [string]$Path,     # endpoint path with query
    [string]$Sentinel, # a key the response MUST contain
    [string]$RowKey,   # a key that appears exactly once per row
    [int]$TimeoutSec = 120
  )

  $file = Join-Path $out $Name
  # Printed BEFORE the request, not after, so a run that stalls says which
  # endpoint it is stalled on. The first version printed nothing until the
  # answer came back, which made a slow query and a dead script look alike.
  Write-Host ('  {0,-18} ' -f $Name) -NoNewline

  # EVERYTHING is inside this try, and that is the point.
  #
  # The first version guarded only the web request and left the write, the row
  # count and the size check outside it. With $ErrorActionPreference = 'Stop',
  # any throw in that unguarded tail killed the whole script -- no error line,
  # no remaining files, no README. The run stopped after the first endpoint and
  # looked, from the folder, exactly like a run that had never been started.
  #
  # One endpoint's problem must cost that endpoint and nothing else. Six files
  # and a named failure beats one file and silence.
  try {
    # 5.1 throws on any non-2xx rather than returning the response, so the
    # status is read back out of the exception below.
    $res  = Invoke-WebRequest -Uri ($Base + $Path) -UseBasicParsing -TimeoutSec $TimeoutSec
    $body = $res.Content
    # 5.1 hands back a byte array instead of a string when the response omits
    # a charset. Every check below is a string operation, so a byte array
    # would silently fail the sentinel test and report healthy data as broken.
    if ($body -is [byte[]]) {
      $body = [System.Text.Encoding]::UTF8.GetString($body)
    }

    # Checking only the status would accept a 200 carrying {"error":"query
    # failed"} -- the API behaving correctly, and still not data.
    if ($body -notmatch [regex]::Escape('"' + $Sentinel + '"')) {
      # Kept on disk, with a name that cannot be mistaken for a snapshot, so
      # whatever came back can be read rather than guessed at.
      Set-Content -LiteralPath "$file.FAILED" -Value $body -Encoding UTF8
      Write-Host "FAILED (answered, but no `"$Sentinel`" in it)" -ForegroundColor Red
      $script:Failed = 1
      return
    }

    Set-Content -LiteralPath $file -Value $body -Encoding UTF8 -NoNewline

    # One occurrence of the row key per row. Crude, exact for these payloads,
    # and it needs no JSON parser. Zero is a legitimate answer -- /air returns
    # no contacts whenever OpenSky is down, which is its normal state right
    # now -- so this must never be treated as a failure.
    $rows  = [regex]::Matches($body, [regex]::Escape('"' + $RowKey + '":')).Count
    # Bytes on disk rather than a rounded size: a 150-byte error page and a
    # real file both read as "4 KB" once anything rounds, and that one
    # measurement is what catches the failure this script exists to catch.
    $bytes = (Get-Item -LiteralPath $file).Length
    Write-Host "ok  $rows rows, $bytes bytes" -ForegroundColor Green
  } catch {
    $code = 0
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $code = [int]$_.Exception.Response.StatusCode
    }
    $why = $_.Exception.Message
    if ($code -eq 0) {
      Write-Host "FAILED (no answer in ${TimeoutSec}s) $why" -ForegroundColor Red
    } else {
      Write-Host "FAILED (HTTP $code) $why" -ForegroundColor Red
    }
    $script:Failed = 1
  }
}

# /hours and /gaps get longer than the rest. They are the two heaviest reads in
# the API -- /hours asks for thousands of rows out of a view that runs two
# correlated subqueries against the gaps table for every one of them -- and a
# timeout there is a slow query, not a broken service.
Get-Snapshot 'crossings.json'   "/crossings?hours=$HoursWindow&limit=$RowLimit" 'rows'         'chokepoint' 180
Get-Snapshot 'hours.json'       "/hours?hours=$HoursWindow"                     'coverage'     'chokepoint' 300
Get-Snapshot 'days.json'        "/days?hours=$HoursWindow"                      'rows'         'chokepoint' 300
Get-Snapshot 'gaps.json'        "/gaps?hours=$HoursWindow&limit=2000"           'rows'         'mmsi'       300
Get-Snapshot 'air.json'         "/air?hours=$HoursWindow"                       'airspaces'    'airspace'   120
Get-Snapshot 'diagnostics.json' '/diagnostics'                                  'chokepoints'  'id'         120
Get-Snapshot 'health.json'      '/health'                                       'rulesVersion' 'ok'         120

Write-Host ''

$readme = @'
God's Eye View - chokepoint collector data
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

  Bosphorus crossings are NOT a traffic series - they measure reception.
  From r4 on, every response says so in its `transitSeries` field.

  queue_depth before migration 005 tracked reception, not the anchorage.
  Use queue_share where it exists; ignore the bare depth where it does not.

TO TAKE ANOTHER
  Run collector\scripts\snapshot.ps1 from the repository. It adds a new
  dated folder and never touches the ones already here.
'@
# Written whether or not every endpoint answered. It explains what the files
# mean, and a partial snapshot needs that explanation at least as much as a
# complete one does.
Set-Content -LiteralPath (Join-Path $Root 'README.txt') -Value $readme -Encoding UTF8

$count = (Get-ChildItem -LiteralPath $Root -Directory).Count

if ($script:Failed -ne 0) {
  Write-Host '==> INCOMPLETE. At least one file above is not data.' -ForegroundColor Red
  Write-Host '    Whatever DID download is kept and is good; anything that answered'
  Write-Host '    with the wrong thing is saved with a .FAILED suffix. Re-run when'
  Write-Host '    you like -- a later run adds a folder, it never overwrites one.'
  exit 1
}

Write-Host "==> OK  $count snapshot(s) in $Root" -ForegroundColor Green
Write-Host ''
Write-Host 'OneDrive is uploading now. Check for the green tick in File Explorer'
Write-Host 'before you shut down -- a file still showing the cloud icon has not'
Write-Host 'left this machine yet.'
