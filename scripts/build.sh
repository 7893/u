#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
DIST_DIR="${U_DIST_DIR:-dist}"
mkdir -p "$DIST_DIR"
DEPLOY_ENV_FILE="${U_DEPLOY_ENV_FILE:-deploy.env}"

# Explicit environment variables win; deploy.env fills in only unset build knobs.
ENV_PREFIX="${U_GATE_PREFIX-}"
ENV_CUSTOM_FONTS="${U_CUSTOM_FONTS-}"
if [[ -f "$DEPLOY_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$DEPLOY_ENV_FILE"
  set +a
fi
if [[ -n "$ENV_PREFIX" ]]; then
  U_GATE_PREFIX="$ENV_PREFIX"
fi
if [[ -n "$ENV_CUSTOM_FONTS" ]]; then
  U_CUSTOM_FONTS="$ENV_CUSTOM_FONTS"
fi

PREFIX="${U_GATE_PREFIX:-u-gate}"
case "$PREFIX" in
  *\"*|*\\*) echo "U_GATE_PREFIX contains a quote or backslash" >&2; exit 1 ;;
esac

CUSTOM_FONTS="${U_CUSTOM_FONTS:-0}"

./node_modules/.bin/esbuild web/src/entry.mjs \
  --bundle --minify --format=iife --target=es2020 \
  --external:/u/fonts/* --external:/u/pdfjs/* \
  --define:U_GATE_PREFIX="\"${PREFIX}\"" \
  --outfile="${DIST_DIR}/app.js"

if [[ "$CUSTOM_FONTS" == "1" || "$CUSTOM_FONTS" == "true" ]]; then
  FONT_CSS='@font-face{font-family:"Inter";src:url("/u/fonts/Inter-UI-VF.woff2") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}@font-face{font-family:"Noto Sans SC UI";src:url("/u/fonts/NotoSansSC-UI-VF.woff2") format("woff2");font-weight:400 700;font-style:normal;font-display:swap}@font-face{font-family:"Noto Sans SC Ext";src:url("/u/fonts/NotoSansSC-Ext-VF.woff2") format("woff2");font-weight:400 700;font-style:normal;font-display:swap}'
  tmp_css="$(mktemp "${DIST_DIR}/.app.css.XXXXXX")"
  printf '%s\n' "$FONT_CSS" > "$tmp_css"
  cat "${DIST_DIR}/app.css" >> "$tmp_css"
  chmod 0644 "$tmp_css"
  mv "$tmp_css" "${DIST_DIR}/app.css"

  awk '
    /<!-- U_FONT_PRELOAD -->/ {
      print "<link rel=\"preload\" href=\"/u/fonts/Inter-UI-VF.woff2\" as=\"font\" type=\"font/woff2\" crossorigin>"
      print "<link rel=\"preload\" href=\"/u/fonts/NotoSansSC-UI-VF.woff2\" as=\"font\" type=\"font/woff2\" crossorigin>"
      next
    }
    { print }
  ' web/index.html > "${DIST_DIR}/index.html"
else
  awk '!/<!-- U_FONT_PRELOAD -->/' web/index.html > "${DIST_DIR}/index.html"
fi

gzip -9 -k -f "${DIST_DIR}/app.js" "${DIST_DIR}/app.css" "${DIST_DIR}/index.html"
