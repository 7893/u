"""Verify staged batch files and commit a new manifest on the portal host."""

import fcntl
import grp
import hashlib
import json
import os
import pwd
import shutil
import sys
import tempfile
from pathlib import Path


def _prune_old_releases(batch_parent: Path, batch_id: str, manifest: dict, keep_releases: int) -> None:
    """Remove stale release subdirectories while preserving active and recent ones."""
    if keep_releases < 1:
        return
    prefix = f"batches/{batch_id}/"
    referenced: set[str] = set()
    for entry in manifest.get("batches", []):
        for item in entry.get("files", []):
            rel = str(item.get("path", ""))
            if rel.startswith(prefix):
                rest = rel[len(prefix):].split("/", 1)
                if len(rest) == 2 and rest[0]:
                    referenced.add(rest[0])

    candidates: list[tuple[int, Path]] = []
    for child in batch_parent.iterdir():
        if not child.is_dir() or child.name.startswith(".") or child.name in referenced:
            continue
        try:
            candidates.append((child.stat().st_mtime_ns, child))
        except OSError:
            continue

    candidates.sort(key=lambda pair: pair[0], reverse=True)
    extra_keep = max(0, keep_releases - max(1, len(referenced)))
    for _, old_dir in candidates[extra_keep:]:
        try:
            shutil.rmtree(old_dir)
        except OSError as exc:
            print(f"[WARN] Could not prune old release {old_dir}: {exc}", file=sys.stderr)


def commit_batch(base, stage, owner, group, keep_releases=2):
    base = Path(base)
    stage = Path(stage)
    public = base / "public"
    manifest_path = public / "manifest.json"
    history = base / "data" / ".manifest-history"
    history.mkdir(mode=0o700, exist_ok=True)

    request = json.loads((stage / "batch.json").read_bytes())
    batch = request["batch"]
    release = stage.name.removeprefix(".u_pub.")
    batch_parent = base / "data" / "deliverables" / "batches" / batch["id"]
    batch_parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    target = batch_parent / release

    with tempfile.TemporaryDirectory(prefix=".incoming-", dir=batch_parent) as temporary:
        prepared = Path(temporary)
        os.chown(prepared, owner, group)
        prepared.chmod(0o750)
        for item in batch["files"]:
            filename = item["name"]
            path = prepared / filename
            shutil.copyfile(stage / "files" / filename, path)
            with path.open("rb") as data:
                digest = hashlib.file_digest(data, "sha256").hexdigest()
            if path.stat().st_size != item["bytes"] or digest != request["checksums"][filename]:
                raise ValueError(f"Staged file differs from source: {filename}")
            os.chown(path, owner, group)
            path.chmod(0o640)
            item["path"] = f"batches/{batch['id']}/{release}/{filename}"

        with (history / "publish.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if manifest_path.exists():
                previous_bytes = manifest_path.read_bytes()
                manifest = json.loads(previous_bytes)
            else:
                manifest = {"version": 1, "updated_at": "", "batches": [], "references": []}
                previous_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
            batches = [entry for entry in manifest.get("batches", []) if entry["id"] != batch["id"]]
            if not request["keep_latest"]:
                for entry in batches:
                    if entry.get("status") == "latest":
                        entry["status"] = "archive"
            manifest["batches"] = [batch, *batches]
            manifest["updated_at"] = batch["date"]
            manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()

            if target.exists():
                raise FileExistsError(target)
            with (history / f"{release}.json").open("xb") as backup:
                backup.write(previous_bytes)

            with tempfile.NamedTemporaryFile(dir=public, prefix=".manifest-", delete=False) as output:
                next_manifest = Path(output.name)
            try:
                next_manifest.write_bytes(manifest_bytes)
                os.chown(next_manifest, owner, group)
                next_manifest.chmod(0o644)
                prepared.rename(target)
                # Stop serving the old precompressed copy before switching the JSON.
                # Nginx can gzip the current JSON dynamically.
                manifest_path.with_suffix(".json.gz").unlink(missing_ok=True)
                next_manifest.replace(manifest_path)
            finally:
                next_manifest.unlink(missing_ok=True)

            _prune_old_releases(batch_parent, batch["id"], manifest, keep_releases)

    return manifest_bytes


if __name__ == "__main__":
    base, stage = map(Path, sys.argv[1:])
    user = os.environ.get("INSTALL_USER", "www")
    group = os.environ.get("INSTALL_GROUP", "www")
    keep = int(os.environ.get("U_KEEP_RELEASES", "2"))
    sys.stdout.buffer.write(commit_batch(
        base, stage, pwd.getpwnam(user).pw_uid, grp.getgrnam(group).gr_gid, keep_releases=keep
    ))
