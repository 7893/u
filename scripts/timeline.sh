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
U_PYTHON="${U_PYTHON:-python3}"
ssh "$DEPLOY_SSH_HOST" "${U_PYTHON} ${REMOTE_BASE}/bin/stats.py --timeline"
