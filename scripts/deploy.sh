#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
if [[ -f deploy.env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./deploy.env
  set +a
fi
: "${DEPLOY_SSH_HOST:?Copy .env.example to deploy.env and set DEPLOY_SSH_HOST}"
: "${REMOTE_BASE:?Copy .env.example to deploy.env and set REMOTE_BASE}"
: "${INSTALL_USER:=www}"
: "${INSTALL_GROUP:=www}"
: "${STATS_USER:=$INSTALL_USER}"
: "${STATS_GROUP:=$INSTALL_GROUP}"
: "${NGINX_CONF_DIR:=/etc/nginx}"
: "${NGINX_GROUP:=root}"
: "${U_PYTHON:=python3}"
: "${REQUIRE_LEGACY_MAP:=0}"
DEPLOY_NGINX=0
DEPLOY_STATS=0
DEPLOY_PDFJS=0

for arg in "$@"; do
  case "$arg" in
    --nginx) DEPLOY_NGINX=1 ;;
    --stats) DEPLOY_STATS=1 ;;
    --pdfjs) DEPLOY_PDFJS=1 ;;
    --all)   DEPLOY_NGINX=1; DEPLOY_STATS=1; DEPLOY_PDFJS=1 ;;
    -h|--help)
      echo "Usage: $0 [--stats] [--nginx] [--pdfjs] [--all]"
      echo "  (default)  Build web/ and deploy index.html, app.js, app.css (+ .gz)"
      echo "  --stats    Also deploy server/stats.py"
      echo "  --nginx    Also render and deploy the two /u nginx configs"
      echo "  --pdfjs    Also deploy the PDF.js runtime"
      echo "  --all      Deploy frontend + pdfjs + stats.py + nginx"
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

LOCAL_TMP="$(mktemp -d)"
STAGE=""
REMOTE_CLEANED=0

cleanup() {
  rm -rf -- "$LOCAL_TMP"
  if [[ -n "$STAGE" && "$REMOTE_CLEANED" -eq 0 ]]; then
    ssh "$DEPLOY_SSH_HOST" "rm -rf -- '$STAGE'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "[1/3] Building frontend bundle..."
./scripts/build.sh

UPLOAD_FILES=(
  dist/index.html dist/index.html.gz
  dist/app.js dist/app.js.gz
  dist/app.css dist/app.css.gz
)

if [[ "$DEPLOY_PDFJS" -eq 1 ]]; then
  echo "      Packaging PDF.js runtime, cmaps, standard_fonts & wasm..."
  PDFJS_SRC="$ROOT_DIR/node_modules/pdfjs-dist"
  PDFJS_STAGE="$LOCAL_TMP/pdfjs"
  mkdir -p "$PDFJS_STAGE"
  cp "$PDFJS_SRC/build/pdf.min.mjs" "$PDFJS_SRC/build/pdf.worker.min.mjs" "$PDFJS_STAGE/"
  cp -R "$PDFJS_SRC/cmaps" "$PDFJS_STAGE/cmaps"
  cp -R "$PDFJS_SRC/standard_fonts" "$PDFJS_STAGE/standard_fonts"
  cp -R "$PDFJS_SRC/wasm" "$PDFJS_STAGE/wasm"
  find "$PDFJS_STAGE" -type f ! -name '*.gz' -exec gzip -9 -k -f {} +
  tar -C "$PDFJS_STAGE" -cf "$LOCAL_TMP/pdfjs.tar" .
  UPLOAD_FILES+=("$LOCAL_TMP/pdfjs.tar")
fi

if [[ "$DEPLOY_STATS" -eq 1 ]]; then
  UPLOAD_FILES+=(server/stats.py)
fi
if [[ "$DEPLOY_NGINX" -eq 1 ]]; then
  UPLOAD_FILES+=(server/nginx/u_http.conf server/nginx/u_locations.conf)
fi
UPLOAD_FILES+=(scripts/install-release)

echo "[2/3] Uploading assets to private staging dir..."
STAGE="$(ssh "$DEPLOY_SSH_HOST" 'd=$(mktemp -d "$HOME/.u_stage.XXXXXX") && chmod 700 "$d" && printf "%s" "$d"')"
if [[ -z "$STAGE" || "$STAGE" != /*/.u_stage.* ]]; then
  echo "[ERR] Failed to create private remote staging dir: '$STAGE'" >&2
  exit 1
fi

scp -q "${UPLOAD_FILES[@]}" "${DEPLOY_SSH_HOST}:${STAGE}/"

echo "[3/3] Installing on the server and reloading nginx..."
REMOTE_CLEANED=1
quote_env() {
  local name="$1" value="$2"
  case "$value" in
    ""|*"'"*)
      echo "[ERR] $name is empty or contains a single quote" >&2
      exit 1
      ;;
  esac
  printf "%s='%s' " "$name" "$value"
}
REMOTE_ENV="$(
  quote_env STAGE "$STAGE"
  quote_env REMOTE_BASE "$REMOTE_BASE"
  quote_env DEPLOY_STATS "$DEPLOY_STATS"
  quote_env DEPLOY_NGINX "$DEPLOY_NGINX"
  quote_env DEPLOY_PDFJS "$DEPLOY_PDFJS"
  quote_env INSTALL_USER "$INSTALL_USER"
  quote_env INSTALL_GROUP "$INSTALL_GROUP"
  quote_env STATS_USER "$STATS_USER"
  quote_env STATS_GROUP "$STATS_GROUP"
  quote_env NGINX_CONF_DIR "$NGINX_CONF_DIR"
  quote_env NGINX_GROUP "$NGINX_GROUP"
  quote_env U_PYTHON "$U_PYTHON"
  quote_env REQUIRE_LEGACY_MAP "$REQUIRE_LEGACY_MAP"
)"
ssh "$DEPLOY_SSH_HOST" "${REMOTE_ENV}sh -s" <<'EOF'
set -eu
trap 'rm -rf -- "$STAGE"' EXIT
chmod 0755 "$STAGE/install-release"
"$STAGE/install-release" "$STAGE"
EOF
echo "[OK] Deployed cleanly."
