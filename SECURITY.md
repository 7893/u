# Security Policy

## Reporting a Vulnerability

Please do **not** open a public issue for security vulnerabilities. Report suspected vulnerabilities privately via GitHub private vulnerability reporting (Security Advisories) on this repository with steps to reproduce and the affected commit or file.

## Passphrase & Deployment Guidance

1. **Use a high-entropy passphrase.** The gate derives a static digest via `SHA-256(U_GATE_PREFIX + ":" + passphrase)` in the browser and stores that digest in an `HttpOnly; Secure; SameSite=Strict` cookie (`u_key`). Because the hashing scheme is public, choose a random passphrase of at least 16–24 characters (or 96+ bits of entropy) so offline guessing is infeasible if server configs or cookies are ever exposed.
2. **Keep `u.env` root-only (`chmod 600`).** Never commit `u.env`, `deploy.env`, `web/manifest.json`, or `private/` files.
3. **Use a unique `U_GATE_PREFIX` per installation** so a digest from one site cannot unlock another.
4. **Enforce HTTPS only.** Always serve `/u/` over TLS 1.3 with valid certificates; avoid `--insecure` in `scripts/publish_batch.py` for production hosts.
5. **Rotate passphrases after suspected exposure.** Changing the passphrase in `u.env` and redeploying `--nginx` immediately invalidates all existing `u_key` cookies.
