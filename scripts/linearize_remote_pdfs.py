#!/usr/bin/env python3
"""
linearize_remote_pdfs.py — Convert delivered PDFs into Fast Web View
(linearized via qpdf --linearize) so PDF.js renders page 1 immediately via HTTP Range.
Verifies page count and Optimized: yes before replacing each file, then atomically
reconciles updated byte sizes into the live manifest (with publish.lock and history
backup) and syncs local web/manifest.json.
"""
import base64
import json
import os
import shlex
import subprocess
import tempfile

from project_env import require_deploy

SSH_HOST = ""
REMOTE_BASE = ""
LOCAL_MANIFEST = ""
PY = "python3"
INSTALL_USER = "www"
INSTALL_GROUP = "www"


REMOTE_UPDATE_MANIFEST = r"""
import base64, fcntl, grp, json, os, pwd, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

base = Path(sys.argv[1])
updates = json.loads(base64.b64decode(os.environ["U_BYTE_UPDATES_B64"]))
owner = pwd.getpwnam(os.environ.get("INSTALL_USER", "www")).pw_uid
group = grp.getgrnam(os.environ.get("INSTALL_GROUP", "www")).gr_gid

public = base / "public"
manifest_path = public / "manifest.json"
history = base / "data" / ".manifest-history"
history.mkdir(mode=0o700, parents=True, exist_ok=True)

with (history / "publish.lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    previous_bytes = manifest_path.read_bytes()
    manifest = json.loads(previous_bytes)
    for batch in manifest.get("batches", []):
        for item in batch.get("files", []):
            rel = item.get("path")
            if rel in updates:
                item["bytes"] = int(updates[rel])
    for item in manifest.get("references", []):
        rel = item.get("path")
        if rel in updates:
            item["bytes"] = int(updates[rel])

    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    stamp = datetime.now(timezone.utc).strftime("lin-%Y%m%dT%H%M%S%fZ")
    with (history / f"{stamp}.json").open("xb") as backup:
        backup.write(previous_bytes)

    with tempfile.NamedTemporaryFile(dir=public, prefix=".manifest-", delete=False) as out:
        next_manifest = Path(out.name)
    try:
        next_manifest.write_bytes(manifest_bytes)
        os.chown(next_manifest, owner, group)
        next_manifest.chmod(0o644)
        manifest_path.with_suffix(".json.gz").unlink(missing_ok=True)
        next_manifest.replace(manifest_path)
    finally:
        next_manifest.unlink(missing_ok=True)

sys.stdout.buffer.write(manifest_bytes)
"""


def pdf_meta(path: str):
    out = subprocess.check_output(["pdfinfo", path], stderr=subprocess.DEVNULL, text=True)
    pages = None
    optimized = False
    for line in out.splitlines():
        if line.startswith("Pages:"):
            pages = int(line.split(":")[1].strip())
        elif line.startswith("Optimized:"):
            optimized = line.split(":")[1].strip().lower() == "yes"
    return pages, optimized


def write_local_manifest(raw_bytes: bytes):
    parent = os.path.dirname(LOCAL_MANIFEST)
    os.makedirs(parent, exist_ok=True)
    tmp_local = f"{LOCAL_MANIFEST}.tmp.{os.getpid()}"
    try:
        with open(tmp_local, "wb") as f:
            f.write(raw_bytes)
        os.replace(tmp_local, LOCAL_MANIFEST)
    finally:
        if os.path.exists(tmp_local):
            try:
                os.unlink(tmp_local)
            except OSError:
                pass


def sync_manifest_updates(byte_updates: dict[str, int]):
    blob = base64.b64encode(json.dumps(byte_updates).encode("utf-8")).decode("ascii")
    cmd = " ".join([
        "sudo -n env",
        "INSTALL_USER=" + shlex.quote(INSTALL_USER),
        "INSTALL_GROUP=" + shlex.quote(INSTALL_GROUP),
        "U_BYTE_UPDATES_B64=" + shlex.quote(blob),
        shlex.quote(PY) + " - " + shlex.quote(REMOTE_BASE),
    ])
    res = subprocess.run(["ssh", SSH_HOST, cmd], input=REMOTE_UPDATE_MANIFEST, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Remote manifest update failed:\n{res.stderr}\n{res.stdout}")
    write_local_manifest(res.stdout.encode("utf-8"))


def main():
    global SSH_HOST, REMOTE_BASE, LOCAL_MANIFEST, PY, INSTALL_USER, INSTALL_GROUP
    cfg = require_deploy()
    SSH_HOST = cfg["DEPLOY_SSH_HOST"]
    REMOTE_BASE = cfg["REMOTE_BASE"]
    LOCAL_MANIFEST = cfg["LOCAL_MANIFEST"]
    PY = cfg["U_PYTHON"]
    INSTALL_USER = cfg["INSTALL_USER"]
    INSTALL_GROUP = cfg["INSTALL_GROUP"]

    live_raw = subprocess.check_output(
        ["ssh", SSH_HOST, f"cat -- {shlex.quote(f'{REMOTE_BASE}/public/manifest.json')}"], text=True
    )
    manifest = json.loads(live_raw)

    all_items = []
    for batch in manifest.get("batches", []):
        all_items.extend(batch.get("files", []))
    all_items.extend(manifest.get("references", []))

    remote_stage = subprocess.check_output(
        ["ssh", SSH_HOST, 'd=$(mktemp -d "$HOME/.u_lin.XXXXXX") && chmod 700 "$d" && printf "%s" "$d"'],
        text=True,
    ).strip()
    if not remote_stage or "/.u_lin." not in remote_stage:
        raise RuntimeError(f"Unexpected remote staging dir: {remote_stage!r}")
    q_stage = shlex.quote(remote_stage)

    byte_updates: dict[str, int] = {}
    try:
        try:
            with tempfile.TemporaryDirectory() as td:
                for item in all_items:
                    if (item.get("ext") or "").upper() != "PDF":
                        continue
                    rel = item["path"]
                    if rel.startswith("/") or ".." in rel.split("/"):
                        raise ValueError(f"Unsafe manifest path: {rel!r}")
                    remote_path = f"{REMOTE_BASE}/data/deliverables/{rel}"
                    local_orig = os.path.join(td, "orig.pdf")
                    local_lin = os.path.join(td, "lin.pdf")
                    for f in (local_orig, local_lin):
                        if os.path.exists(f):
                            os.remove(f)

                    subprocess.check_call(["scp", "-q", f"{SSH_HOST}:{remote_path}", local_orig])
                    orig_size = os.path.getsize(local_orig)
                    orig_pages, orig_opt = pdf_meta(local_orig)
                    if orig_opt:
                        if item.get("bytes") != orig_size:
                            print(
                                f"[SYNC] Reconciled bytes for already-linearized {rel}: "
                                f"{item.get('bytes')} -> {orig_size}"
                            )
                            byte_updates[rel] = orig_size
                        else:
                            print(f"[SKIP] Already linearized: {rel} ({orig_pages}p, {orig_size:,} B)")
                        continue

                    res = subprocess.run(
                        ["qpdf", "--linearize", local_orig, local_lin],
                        capture_output=True,
                        text=True,
                    )
                    if res.returncode not in (0, 3):
                        raise RuntimeError(f"qpdf failed for {rel}: {res.stderr}")
                    lin_size = os.path.getsize(local_lin)
                    lin_pages, lin_opt = pdf_meta(local_lin)
                    if lin_pages != orig_pages:
                        raise RuntimeError(f"Page mismatch for {rel}: {orig_pages} vs {lin_pages}")
                    if not lin_opt:
                        raise RuntimeError(f"Failed to linearize {rel}")

                    stage_pdf = f"{remote_stage}/lin_upload.pdf"
                    subprocess.check_call(["scp", "-q", local_lin, f"{SSH_HOST}:{stage_pdf}"])
                    subprocess.check_call([
                        "ssh", SSH_HOST,
                        f"set -eu && sudo -n install -o {shlex.quote(INSTALL_USER)} -g {shlex.quote(INSTALL_GROUP)} -m 0640 -- {shlex.quote(stage_pdf)} {shlex.quote(remote_path)} "
                        f"&& rm -f -- {shlex.quote(stage_pdf)}",
                    ])
                    byte_updates[rel] = lin_size
                    delta_kb = (lin_size - orig_size) / 1024.0
                    print(
                        f"[OK] Linearized {rel}: {orig_pages}p | "
                        f"{orig_size/1024:.1f} KB -> {lin_size/1024:.1f} KB ({delta_kb:+.1f} KB) | Optimized: yes"
                    )
        finally:
            if byte_updates:
                sync_manifest_updates(byte_updates)
                print(f"\n[DONE] Persisted {len(byte_updates)} PDF update(s) and synced manifest.json!")
            else:
                print("\n[DONE] All delivered PDFs are already linearized and manifest bytes match.")
    finally:
        subprocess.run(["ssh", SSH_HOST, f"rm -rf -- {q_stage}"], check=False)


if __name__ == "__main__":
    main()
