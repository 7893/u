#!/usr/bin/env python3
"""Publish one deliverable batch to the configured /u host.

Example:
  python3 scripts/publish_batch.py --dir /path/to/files --id 20261120_demo --title "Demo" --dry-run
"""
import argparse
import base64
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from project_env import require_deploy

SSH_HOST = ""
REMOTE_BASE = ""
BASE_URL = ""
LOCAL_MANIFEST = ""
PY = "python3"
INSTALL_USER = "www"
INSTALL_GROUP = "www"


def get_pdf_pages(path: str):
    try:
        out = subprocess.check_output(["pdfinfo", path], stderr=subprocess.DEVNULL, text=True)
        for line in out.splitlines():
            if line.startswith("Pages:"):
                return int(line.split(":")[1].strip())
    except Exception:
        pass
    return None


UPLOAD_PREFIX_RE = re.compile(r"^\d{8}_\d{6}_[0-9a-f]{6}_")


def safe_filename(name: str) -> str:
    cleaned = UPLOAD_PREFIX_RE.sub("", name.strip())
    stem, ext = os.path.splitext(cleaned)
    ext_clean = re.sub(r"[^A-Za-z0-9.]", "", ext)
    if ext_clean and not ext_clean.startswith("."):
        ext_clean = "." + ext_clean
    stem_clean = re.sub(r"\s+", "_", stem)
    stem_clean = re.sub(r"[^\w.-]", "_", stem_clean, flags=re.UNICODE)
    stem_clean = re.sub(r"_+", "_", stem_clean)
    stem_clean = stem_clean.lstrip(".-_").rstrip("_.")
    if not stem_clean:
        h = hashlib.sha256(name.encode("utf-8")).hexdigest()[:8]
        stem_clean = f"file_{h}"
    return f"{stem_clean}{ext_clean}"


def scan_dir(src_dir: str, batch_id: str, file_lang: str, desc_map: dict, allowed_exts: set):
    entries = []
    total_pages = 0
    seen_names = set()
    for fn in sorted(os.listdir(src_dir)):
        full = os.path.join(src_dir, fn)
        if not os.path.isfile(full) or fn.startswith("."):
            continue
        ext = os.path.splitext(fn)[1].lstrip(".").upper() or "FILE"
        if allowed_exts and ext.lower() not in allowed_exts:
            continue
        size = os.path.getsize(full)
        clean_name = safe_filename(fn)
        if clean_name in seen_names:
            stem, ext_part = os.path.splitext(clean_name)
            idx = 2
            while f"{stem}_{idx}{ext_part}" in seen_names:
                idx += 1
            dedup_name = f"{stem}_{idx}{ext_part}"
            print(f"[WARN] Duplicate sanitized name '{clean_name}' for '{fn}', renamed to '{dedup_name}'", file=sys.stderr)
            clean_name = dedup_name
        seen_names.add(clean_name)
        pages = get_pdf_pages(full) if ext == "PDF" else None
        if pages:
            total_pages += pages
        item = {
            "name": clean_name,
            "path": f"batches/{batch_id}/{clean_name}",
            "ext": ext,
            "lang": file_lang,
            "desc": desc_map.get(fn) or desc_map.get(clean_name) or "",
            "bytes": size,
            "preview": ext == "PDF",
        }
        if pages is not None:
            item["pages"] = pages
        entries.append((full, clean_name, item))
    return entries, total_pages


def linearize_pdf_if_possible(src_path: str, dst_path: str) -> str:
    """Linearize PDF (Fast Web View) with qpdf --linearize so PDF.js streams page 1 immediately."""
    if not shutil.which("qpdf"):
        return src_path
    try:
        orig_pages = get_pdf_pages(src_path)
        res = subprocess.run(
            ["qpdf", "--linearize", src_path, dst_path],
            capture_output=True,
            text=True,
        )
        if res.returncode in (0, 3) and os.path.isfile(dst_path) and os.path.getsize(dst_path) > 0:
            new_pages = get_pdf_pages(dst_path)
            if orig_pages is None or new_pages == orig_pages:
                return dst_path
    except Exception:
        pass
    return src_path


def ssh(cmd: str, script: str | None = None) -> str:
    res = subprocess.run(["ssh", SSH_HOST, cmd], input=script, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"SSH failed:\n{res.stderr}\n{res.stdout}")
    return res.stdout


def write_local_manifest(raw_bytes: bytes):
    parent = os.path.dirname(LOCAL_MANIFEST)
    os.makedirs(parent, exist_ok=True)
    tmp_path = f"{LOCAL_MANIFEST}.tmp.{os.getpid()}"
    try:
        with open(tmp_path, "wb") as f:
            f.write(raw_bytes)
        os.replace(tmp_path, LOCAL_MANIFEST)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def main():
    global SSH_HOST, REMOTE_BASE, BASE_URL, LOCAL_MANIFEST, PY, INSTALL_USER, INSTALL_GROUP
    cfg = require_deploy()
    SSH_HOST = cfg["DEPLOY_SSH_HOST"]
    REMOTE_BASE = cfg["REMOTE_BASE"]
    BASE_URL = cfg["PUBLIC_ORIGIN"]
    LOCAL_MANIFEST = cfg["LOCAL_MANIFEST"]
    PY = cfg["U_PYTHON"]
    INSTALL_USER = cfg["INSTALL_USER"]
    INSTALL_GROUP = cfg["INSTALL_GROUP"]

    ap = argparse.ArgumentParser(description="Publish a new deliverable batch to /u/")
    ap.add_argument("--dir", required=True, help="Local directory containing PDF/ZIP files to publish")
    ap.add_argument("--id", required=True, help="Batch ID (e.g. 20261120_demo_en_US)")
    ap.add_argument("--title", required=True, help="Batch display title")
    ap.add_argument("--lang-badge", default="", help="Batch language badge (e.g. IT / ZH → en_US)")
    ap.add_argument("--file-lang", default="", help="Per-file language label (e.g. 中 → 美式英)")
    ap.add_argument("--summary", default="", help="Custom batch summary (auto-generated if omitted)")
    ap.add_argument("--date", default=datetime.now().strftime("%Y-%m-%d"), help="Batch date (YYYY-MM-DD)")
    ap.add_argument("--desc-json", default="", help="Optional JSON file mapping filename -> description")
    ap.add_argument("--exts", default="pdf,zip,docx,xlsx,pptx,txt,md", help="Comma-separated file extensions to include")
    ap.add_argument("--keep-latest", action="store_true", help="Do not demote existing latest batches to archive")
    ap.add_argument("--insecure", action="store_true", help="Skip TLS certificate verification during live HEAD checks")
    ap.add_argument("--dry-run", action="store_true", help="Preview batch JSON without uploading")
    args = ap.parse_args()

    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", args.id) or ".." in args.id:
        sys.exit(
            f"Invalid --id '{args.id}': must start with alphanumeric, use only [A-Za-z0-9._-], and not contain '..'"
        )
    if not os.path.isdir(args.dir):
        sys.exit(f"Directory not found: {args.dir}")

    desc_map = {}
    if args.desc_json:
        with open(args.desc_json, "r", encoding="utf-8") as f:
            desc_map = json.load(f)

    allowed_exts = {e.strip().lower().lstrip(".") for e in args.exts.split(",") if e.strip()}
    scanned, total_pages = scan_dir(args.dir, args.id, args.file_lang, desc_map, allowed_exts)
    if not scanned:
        sys.exit(f"No files found in {args.dir}")

    summary = args.summary
    if not summary:
        parts = [f"{len(scanned)} 份"]
        if total_pages > 0:
            parts.append(f"共 {total_pages} 页")
        if args.lang_badge:
            parts.append(args.lang_badge)
        summary = " · ".join(parts)

    new_batch = {
        "id": args.id,
        "date": args.date,
        "title": args.title,
        "status": "latest",
        "lang_badge": args.lang_badge,
        "summary": summary,
        "files": [item for _, _, item in scanned],
    }

    print("=== Batch Manifest Preview ===")
    print(json.dumps(new_batch, ensure_ascii=False, indent=2))

    if args.dry_run:
        print("\n[DRY-RUN] No changes applied to the server.")
        return

    # Keep the local manifest mirror ordered for concurrent runs on this workstation.
    cache_dir = Path.home() / ".cache"
    cache_dir.mkdir(exist_ok=True)
    with (cache_dir / "u-publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        batch = publish_batch(scanned, new_batch, args.keep_latest)

    insecure_tls = args.insecure or cfg.get("U_INSECURE_TLS", "").lower() in ("1", "true", "yes")
    verify_batch(batch, insecure=insecure_tls)
    print(f"\nALL DONE: Batch '{args.id}' is live at {BASE_URL}/u/")


def publish_batch(scanned, batch, keep_latest):
    remote_stage = ssh('d=$(mktemp -d "$HOME/.u_pub.XXXXXX") && chmod 700 "$d" && mkdir -p "$d/files" && printf "%s" "$d"').strip()
    if not remote_stage.startswith("/") or not re.fullmatch(r"\.u_pub\.[A-Za-z0-9]{6}", Path(remote_stage).name):
        raise RuntimeError(f"Unexpected remote staging directory: {remote_stage!r}")
    q_stage = shlex.quote(remote_stage)

    try:
        with tempfile.TemporaryDirectory() as temporary:
            checksums = {}
            for local_path, clean_name, item in scanned:
                upload_path = local_path
                if item["ext"] == "PDF":
                    upload_path = linearize_pdf_if_possible(local_path, os.path.join(temporary, clean_name))
                item["bytes"] = os.path.getsize(upload_path)
                with open(upload_path, "rb") as data:
                    checksums[clean_name] = hashlib.file_digest(data, "sha256").hexdigest()
                subprocess.check_call(["scp", "-q", upload_path, f"{SSH_HOST}:{remote_stage}/files/{clean_name}"])

            request_path = Path(temporary) / "batch.json"
            request_path.write_text(json.dumps({
                "batch": batch, "keep_latest": keep_latest, "checksums": checksums,
            }, ensure_ascii=False), encoding="utf-8")
            subprocess.check_call(["scp", "-q", str(request_path), f"{SSH_HOST}:{remote_stage}/"])

        commit_script = Path(__file__).with_name("commit_batch.py").read_text(encoding="utf-8")
        live_raw = ssh(
            "sudo -n env "
            + "INSTALL_USER=" + shlex.quote(INSTALL_USER) + " "
            + "INSTALL_GROUP=" + shlex.quote(INSTALL_GROUP) + " "
            + shlex.quote(PY) + " - " + shlex.quote(REMOTE_BASE) + " " + q_stage,
            commit_script,
        )
        live_manifest = json.loads(live_raw)
        committed_batch = next(entry for entry in live_manifest["batches"] if entry["id"] == batch["id"])
        write_local_manifest(live_raw.encode("utf-8"))
        print(f"[OK] Published {len(committed_batch['files'])} files and synced {LOCAL_MANIFEST}")
        try:
            ssh(f"{shlex.quote(PY)} {shlex.quote(f'{REMOTE_BASE}/bin/stats.py')} --build")
        except RuntimeError as error:
            print(f"[WARN] Batch is live. Could not rebuild stats: {error}", file=sys.stderr)
        return committed_batch
    finally:
        try:
            ssh(f"rm -rf {q_stage}")
        except RuntimeError as error:
            print(f"[WARN] Could not remove staging: {error}", file=sys.stderr)


def verify_batch(batch, insecure: bool = False):
    checks = []
    for item in batch["files"]:
        enc = "/".join(quote(seg) for seg in item["path"].split("/"))
        modes = [("files", "attachment")]
        if item.get("preview"):
            modes.append(("view", "inline"))
        for mode, disp in modes:
            checks.append(
                {
                    "path": f"/u/{mode}/{enc}",
                    "bytes": item["bytes"],
                    "disp": disp,
                    "name": item["name"],
                }
            )
    blob = base64.b64encode(json.dumps(checks).encode()).decode()
    cmd = " ".join(
        [
            "sudo -n env",
            "U_ENV_FILE=" + shlex.quote(REMOTE_BASE + "/etc/u.env"),
            "U_CHECKS_B64=" + shlex.quote(blob),
            "U_INSECURE_TLS=" + ("1" if insecure else "0"),
            shlex.quote(PY) + " -",
        ]
    )
    output = ssh(cmd, VERIFY_REMOTE)
    print(output.rstrip())


VERIFY_REMOTE = r"""
import base64, hashlib, json, os, ssl
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

def read_env(path):
    env = {}
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            env[key.strip()] = value
    return env

env = read_env(os.environ["U_ENV_FILE"])
digest = env.get("U_PASS_SHA256", "")
if not digest:
    digest = hashlib.sha256(f"{env['U_GATE_PREFIX']}:{env['U_PASS']}".encode()).hexdigest()
origin = env["PUBLIC_ORIGIN"].rstrip("/")
host = urlsplit(origin).hostname
checks = json.loads(base64.b64decode(os.environ["U_CHECKS_B64"]))
insecure = os.environ.get("U_INSECURE_TLS", "").lower() in ("1", "true", "yes")
context = ssl._create_unverified_context() if insecure else ssl.create_default_context()
for item in checks:
    url = origin + item["path"]
    request = Request(url, method="HEAD", headers={"Cookie": "u_key=" + digest, "Host": host})
    try:
        with urlopen(request, context=context, timeout=30) as response:
            status = response.status
            headers = {k.lower(): v for k, v in response.headers.items()}
    except Exception:
        raise SystemExit("HTTP check failed for " + item["path"]) from None
    if status != 200:
        raise SystemExit("HTTP check failed for " + item["path"] + ": " + str(status))
    if headers.get("content-length") != str(item["bytes"]):
        raise SystemExit("Size mismatch for " + item["path"])
    if not headers.get("content-disposition", "").lower().startswith(item["disp"]):
        raise SystemExit("Disposition mismatch for " + item["path"])
    print("VERIFIED", item["name"], item["bytes"])
"""

if __name__ == "__main__":
    main()
