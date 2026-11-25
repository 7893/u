#!/usr/bin/env python3
"""Load deploy.env from this project. This file never reads the home directory .env."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOY_ENV = ROOT / "deploy.env"


def load_deploy_env() -> dict[str, str]:
    values: dict[str, str] = {}
    if DEPLOY_ENV.is_file():
        for raw in DEPLOY_ENV.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[key.strip()] = value
    for key in (
        "DEPLOY_SSH_HOST",
        "REMOTE_BASE",
        "PUBLIC_ORIGIN",
        "U_GATE_PREFIX",
        "U_CUSTOM_FONTS",
        "U_PYTHON",
        "INSTALL_USER",
        "INSTALL_GROUP",
        "STATS_USER",
        "STATS_GROUP",
        "NGINX_CONF_DIR",
        "NGINX_GROUP",
        "REQUIRE_LEGACY_MAP",
        "U_INSECURE_TLS",
    ):
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values


def require_deploy() -> dict[str, str]:
    values = load_deploy_env()
    missing = [
        key for key in ("DEPLOY_SSH_HOST", "REMOTE_BASE", "PUBLIC_ORIGIN") if not values.get(key)
    ]
    if missing:
        raise SystemExit(
            "Missing "
            + ", ".join(missing)
            + ". Copy .env.example to deploy.env in the project directory."
        )
    values.setdefault("U_GATE_PREFIX", "u-gate")
    values.setdefault("U_PYTHON", "python3")
    values.setdefault("INSTALL_USER", "www")
    values.setdefault("INSTALL_GROUP", "www")
    values.setdefault("STATS_USER", values["INSTALL_USER"])
    values.setdefault("STATS_GROUP", values["INSTALL_GROUP"])
    values.setdefault("NGINX_CONF_DIR", "/etc/nginx")
    values.setdefault("NGINX_GROUP", "root")
    values["PUBLIC_ORIGIN"] = values["PUBLIC_ORIGIN"].rstrip("/")
    values["REMOTE_BASE"] = values["REMOTE_BASE"].rstrip("/")
    values["NGINX_CONF_DIR"] = values["NGINX_CONF_DIR"].rstrip("/")
    values["LOCAL_MANIFEST"] = str(ROOT / "web" / "manifest.json")
    return values
