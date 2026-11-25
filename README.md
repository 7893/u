# u

Self-hosted file exchange portal with an in-page PDF.js reader and Uppy multi-file uploader. Visitors unlock one shared passphrase, then preview or download published files and upload new ones.

> **UI language note:** The current web interface (`web/index.html` and `web/src/entry.mjs`) is written in Simplified Chinese (`zh-CN`).

## Requirements

- **Build machine:** Node.js `>= 22`, Python `>= 3.11` (optional `qpdf` and `pdfinfo` for Fast Web View PDF linearization and page counts).
- **Target server:** Python `>= 3.11` and standard Nginx compiled with `http_ssl_module`, `http_v2_module`, `http_auth_request_module`, `http_dav_module`, and `http_gzip_static_module` (no third-party Nginx modules required).

## Layout

```text
web/                 browser page, styles, and manifest.example.json
server/              stats.py, nginx templates (including site.example.conf), and log rotation examples
scripts/             build, deploy, install, host bootstrap, publish, and unit tests
```

`web/` is the page. `server/` is what stays installed on the host. `scripts/` is what you and CI run. `install-release` is copied over only for that deploy and is not left in the server `bin` directory.

The live catalog is `web/manifest.json`. That file is gitignored. Start from `web/manifest.example.json`.

## Configure

### 1. Local / CI configuration (`deploy.env`)

Copy `.env.example` to `deploy.env` in this directory. It holds the SSH host, install root, gate prefix, file owner, nginx config directory, and server Python interpreter. It does not hold the passphrase.

Optional flags in `deploy.env`:
- `U_CUSTOM_FONTS=1` — include self-hosted `/u/fonts/*.woff2` preloads and `@font-face` rules (default `0` uses system fonts with zero 404 requests).
- `REQUIRE_LEGACY_MAP=1` — refuse installing `stats.py` if `$REMOTE_BASE/etc/legacy-map.json` is missing (default `0` allows empty legacy maps on fresh installs).

### 2. Server bootstrap & secrets

Initialize a fresh server directory tree with `scripts/init-host`:

```bash
REMOTE_BASE=/srv/u INSTALL_USER=www-data INSTALL_GROUP=www-data ./scripts/init-host
```

Create `$REMOTE_BASE/etc/u.env` (for example `/srv/u/etc/u.env`) and keep it readable only by root (`chmod 600`):

```text
U_PASS=choose-a-high-entropy-passphrase
U_GATE_PREFIX=u-gate
PUBLIC_ORIGIN=https://files.example
STATS_EXCLUDE_IPS=
# Optional: advertise HTTP/3 only if your HTTPS server enables QUIC
# U_ALT_SVC=h3=":443"; ma=86400
# Optional: override internal loopback track sink port (default 19204)
# U_TRACK_PORT=19204
```

Set `U_PASS_SHA256` instead of `U_PASS` when the server already has the 64-character digest and the passphrase itself should not be written into the file. Put `STATS_EXCLUDE_IPS` in `$REMOTE_BASE/etc/stats.env` when the statistics job runs as a non-root user.

`U_GATE_PREFIX` in `deploy.env` and `u.env` must match. The built page contains the prefix. The passphrase stays on the server and is never committed. `install-release` hashes `prefix:passphrase` into the nginx templates.

Old top-level download paths, if migrating from an older layout, go in `$REMOTE_BASE/etc/legacy-map.json`.

### 3. Nginx integration

`server/nginx/u_http.conf` and `server/nginx/u_locations.conf` are self-contained (including `zone=u_general` and standard Nginx directives only). Include `u_http.conf` in `http { ... }` and `u_locations.conf` inside your HTTPS `server { ... }` block. See `server/nginx/site.example.conf` for a complete standalone domain example.

## Build and deploy

```bash
npm ci
npm test
npm run build
./scripts/deploy.sh --all
```

`npm test` runs both the gate/template suite (`scripts/test-gate.mjs`) and the Python operations suite (`scripts/test_ops.py`).

`./scripts/deploy.sh` builds the page and installs it over SSH. `--nginx` renders `u_http.conf` and `u_locations.conf` from `u.env`, runs `nginx -t`, rolls back (removing newly created files on a failed first install), and reloads Nginx across `service`, `systemctl`, or `nginx -s reload`.

`--stats` installs `server/stats.py`. Point a cron job at `stats.py --build-loop` to keep `/u/stats.json` updated (only paths listed in `manifest.json` are exposed in `stats.json`).

## Daily log slicing

`stats.py` reads live `requests.jsonl` / `visitors.jsonl` together with daily-sliced (`*-YYYY-MM-DD.jsonl`, `.gz`, `.bz2`) and numbered rotated archives (`.N.gz`, `.N.bz2`). You can slice logs daily using:
- Built-in command (run via cron at midnight, then signal Nginx to reopen logs):
  ```bash
  python3 /srv/u/bin/stats.py --rotate-daily --compress --keep-days 90 && sudo nginx -s reopen
  ```
- Or OS log rotation templates: `server/logrotate.example` (Linux) / `server/newsyslog.example` (FreeBSD).

## Publish a batch

`scripts/publish_batch.py` linearizes PDFs (if `qpdf` is installed), uploads files with SHA-256 verification, atomically switches `manifest.json` via `scripts/commit_batch.py` (automatically keeping the active and previous release while pruning older ones), and verifies downloads over HTTPS from the server so the passphrase never leaves the host. Pass `--insecure` (or `U_INSECURE_TLS=1`) only for self-signed test certificates. Do not put deliverable files in this repository.

## Privacy

This portal is designed for private, invite-only file exchange with visitor analytics. Visiting the page (including the passphrase gate) reports browser language, time zone, screen size, a canvas/WebGL fingerprint, detected OS fonts, battery state when provided, and page/PDF reading events to `/u/track`. Server logs also record the client IP, TLS parameters, and user agent. All logs stay on your own server.

## GitHub Actions

`.github/workflows/ci.yml` installs dependencies, builds public artifacts, and runs `npm test` on every push and pull request.

For automated SSH deployment from `main`, configure `DEPLOY_SSH_HOST`, `REMOTE_BASE`, `U_GATE_PREFIX`, `INSTALL_USER`, `INSTALL_GROUP`, `STATS_USER`, `STATS_GROUP`, `NGINX_CONF_DIR`, `NGINX_GROUP`, `U_PYTHON` (and optional `U_CUSTOM_FONTS`, `REQUIRE_LEGACY_MAP`) along with `SSH_PRIVATE_KEY` and `SSH_KNOWN_HOSTS` in your CI/CD environment. The passphrase stays in the server's `u.env` and is never a CI variable.

## Security & License

See [SECURITY.md](SECURITY.md) for passphrase guidance and vulnerability reporting.

Licensed under Apache-2.0. The PDF reader is PDF.js (Apache-2.0) and the uploader uses Uppy (MIT). Optional self-hosted fonts are not bundled in this repository.
