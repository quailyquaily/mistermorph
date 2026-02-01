#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Parse a Google Maps URL and extract lat/lng/zoom + best-effort place/query hints.

Usage:
  google_maps_parse.sh [--no-resolve] [--max-time SEC] <google_maps_url>

Examples:
  google_maps_parse.sh "https://maps.app.goo.gl/..."
  google_maps_parse.sh --no-resolve "https://www.google.com/maps/place/.../@37.4219999,-122.0840575,17z"

Output:
  Prints a single JSON object to stdout.
EOF
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing dependency: $1" >&2
    exit 2
  fi
}

url_decode_plus() {
  local s="${1:-}"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$s" <<'PY'
import sys, urllib.parse
print(urllib.parse.unquote_plus(sys.argv[1]))
PY
    return 0
  fi
  # Fallback: only handle '+' to ' ' (percent decoding omitted).
  echo "${s//+/ }"
}

json_emit() {
  need_cmd python3

  python3 - "$@" <<'PY'
import json, sys

(
    input_url,
    resolved_url,
    lat,
    lng,
    zoom,
    place_name,
    query,
    place_id,
) = sys.argv[1:10]

def norm(s: str) -> str | None:
    s = (s or "").strip()
    return s if s else None

def norm_num(s: str) -> float | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(s)
    except Exception:
        return None

out = {
    "input_url": norm(input_url),
    "resolved_url": norm(resolved_url),
    "lat": norm_num(lat),
    "lng": norm_num(lng),
    "zoom": norm_num(zoom),
    "place_name": norm(place_name),
    "query": norm(query),
    "place_id": norm(place_id),
}

print(json.dumps(out, ensure_ascii=False))
PY
}

no_resolve=false
max_time=12

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --no-resolve)
      no_resolve=true
      shift
      ;;
    --max-time)
      shift
      if [[ $# -lt 1 ]]; then
        echo "missing value for --max-time" >&2
        exit 2
      fi
      max_time="$1"
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "unknown flag: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 2
fi

input_url="$1"
resolved_url="$input_url"

if [[ "$no_resolve" != "true" ]]; then
  need_cmd curl
  # Follow redirects and capture the effective URL.
  if ! resolved_url="$(
    curl -sS -L \
      --max-redirs 8 \
      --connect-timeout 5 \
      --max-time "$max_time" \
      -o /dev/null \
      -w '%{url_effective}' \
      "$input_url"
  )"; then
    echo "failed to resolve url (try --no-resolve): $input_url" >&2
    exit 3
  fi
  resolved_url="${resolved_url:-$input_url}"
fi

lat=""
lng=""
zoom=""
place_name=""
query=""
place_id=""

u="$resolved_url"

# 1) @lat,lng,zoomz
if [[ "$u" =~ @(-?[0-9]+(\.[0-9]+)?),(-?[0-9]+(\.[0-9]+)?),([0-9]+(\.[0-9]+)?)z ]]; then
  lat="${BASH_REMATCH[1]}"
  lng="${BASH_REMATCH[3]}"
  zoom="${BASH_REMATCH[5]}"
elif [[ "$u" =~ @(-?[0-9]+(\.[0-9]+)?),(-?[0-9]+(\.[0-9]+)?) ]]; then
  lat="${BASH_REMATCH[1]}"
  lng="${BASH_REMATCH[3]}"
fi

# 2) query params: q=lat,lng or ll=lat,lng or query=lat,lng
if [[ -z "$lat" || -z "$lng" ]]; then
  re_coord_param='([?&]ll=|[?&]q=|[?&]query=)(-?[0-9]+(\.[0-9]+)?),(-?[0-9]+(\.[0-9]+)?)'
  if [[ "$u" =~ $re_coord_param ]]; then
    lat="${BASH_REMATCH[2]}"
    lng="${BASH_REMATCH[4]}"
  fi
fi

# Place ID: query_place_id=...
re_qpid='[?&]query_place_id=([^&]+)'
if [[ "$u" =~ $re_qpid ]]; then
  place_id="$(url_decode_plus "${BASH_REMATCH[1]}")"
fi

# Place name: /place/<name>/... or /maps/place/<name>/...
if [[ "$u" =~ /place/([^/?#]+) ]]; then
  place_name="$(url_decode_plus "${BASH_REMATCH[1]}")"
fi

# Query: q=... (non-numeric) or query=...
re_q='[?&]q=([^&]+)'
re_query='[?&]query=([^&]+)'
if [[ "$u" =~ $re_q ]]; then
  qraw="$(url_decode_plus "${BASH_REMATCH[1]}")"
  if [[ ! "$qraw" =~ ^-?[0-9]+(\.[0-9]+)?,[[:space:]]*-?[0-9]+(\.[0-9]+)?$ ]]; then
    query="$qraw"
  fi
elif [[ "$u" =~ $re_query ]]; then
  qraw="$(url_decode_plus "${BASH_REMATCH[1]}")"
  if [[ ! "$qraw" =~ ^-?[0-9]+(\.[0-9]+)?,[[:space:]]*-?[0-9]+(\.[0-9]+)?$ ]]; then
    query="$qraw"
  fi
fi

json_emit "$input_url" "$resolved_url" "$lat" "$lng" "$zoom" "$place_name" "$query" "$place_id"
