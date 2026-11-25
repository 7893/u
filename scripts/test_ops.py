#!/usr/bin/env python3
"""Unit tests for server/stats.py, scripts/commit_batch.py, and scripts/publish_batch.py."""

import bz2
import gzip
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def load_module(name: str, rel_path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel_path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


class StatsTests(unittest.TestCase):
    def _load_stats(self, base: Path):
        os.environ["U_ROOT"] = str(base)
        return load_module(f"u_stats_{id(base)}", "server/stats.py")

    def tearDown(self):
        os.environ.pop("U_ROOT", None)

    def test_missing_manifest_does_not_crash_and_removes_stale_gz(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            (base / "public").mkdir()
            (base / "data" / ".tmp").mkdir(parents=True)
            (base / "data" / "inbox").mkdir(parents=True)
            (base / "logs").mkdir()
            stale_gz = base / "public" / "stats.json.gz"
            stale_gz.write_bytes(b"stale")

            stats = self._load_stats(base)
            changed = stats.build_stats_json()
            self.assertTrue(changed)
            self.assertFalse(stale_gz.exists())
            data = json.loads((base / "public" / "stats.json").read_text(encoding="utf-8"))
            self.assertEqual(data["downloads"], {})
            self.assertEqual(data["total_downloads"], 0)

    def test_stats_json_hides_unlisted_paths_and_reads_daily_and_compressed_logs(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            (base / "public").mkdir()
            (base / "data" / ".tmp").mkdir(parents=True)
            (base / "data" / "inbox").mkdir(parents=True)
            logs = base / "logs"
            logs.mkdir()

            manifest = {
                "version": 1,
                "batches": [
                    {
                        "id": "b1",
                        "files": [{"name": "doc.pdf", "path": "batches/b1/doc.pdf"}],
                    }
                ],
                "references": [],
            }
            (base / "public" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

            def req_line(msec: float, uri: str, status: int = 200, ip: str = "1.2.3.4"):
                return json.dumps({
                    "ts": "2026-11-24T10:00:00+08:00",
                    "msec": msec,
                    "ip": ip,
                    "method": "GET",
                    "uri": uri,
                    "status": status,
                    "body_bytes": 1024,
                    "bot_flag": 0,
                    "ua": "Mozilla/5.0",
                }) + "\n"

            # Numbered bz2 archive (newsyslog)
            with bz2.open(logs / "requests.jsonl.0.bz2", "wt", encoding="utf-8") as f:
                f.write(req_line(1700000001.0, "/u/files/batches/b1/doc.pdf"))
            # Daily sliced gzip archive
            with gzip.open(logs / "requests-2026-11-23.jsonl.gz", "wt", encoding="utf-8") as f:
                f.write(req_line(1700000100.0, "/u/files/batches/b1/doc.pdf", status=206))
                # Duplicate 206 within 60s should be deduplicated
                f.write(req_line(1700000120.0, "/u/files/batches/b1/doc.pdf", status=206))
            # Live log with an unlisted/temp file path
            (logs / "requests.jsonl").write_text(
                req_line(1700000500.0, "/u/files/tmp_secret/hidden.mov")
                + req_line(1700000510.0, "/u/files/batches/b1/doc.pdf"),
                encoding="utf-8",
            )

            stats = self._load_stats(base)
            downloads, _, _, _, _, _ = stats.parse_requests()
            # Admin parse_requests still sees everything
            self.assertEqual(downloads["batches/b1/doc.pdf"], 3)
            self.assertEqual(downloads["tmp_secret/hidden.mov"], 1)

            # Public stats.json only exposes paths listed in manifest.json
            stats.build_stats_json()
            public_stats = json.loads((base / "public" / "stats.json").read_text(encoding="utf-8"))
            self.assertEqual(public_stats["downloads"], {"batches/b1/doc.pdf": 3})
            self.assertNotIn("tmp_secret/hidden.mov", public_stats["downloads"])
            self.assertEqual(public_stats["total_downloads"], 3)

    def test_rotate_daily_slices_logs_safely_and_prunes_old_days(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            (base / "public").mkdir()
            (base / "data" / ".tmp").mkdir(parents=True)
            logs = base / "logs"
            logs.mkdir()
            (logs / "requests.jsonl").write_text('{"a":1}\n', encoding="utf-8")
            (logs / "visitors.jsonl").write_text('{"b":2}\n', encoding="utf-8")
            # Pre-existing old slice that should be pruned with keep_days=7
            old_slice = logs / "visitors-2020-01-01.jsonl.gz"
            old_slice.write_bytes(gzip.compress(b'{"old":true}\n'))

            stats = self._load_stats(base)
            rotated = stats.rotate_daily_logs(date_str="2026-11-24", compress=True, keep_days=7)
            self.assertEqual(len(rotated), 2)
            self.assertTrue((logs / "requests-2026-11-24.jsonl.gz").is_file())
            self.assertTrue((logs / "visitors-2026-11-24.jsonl.gz").is_file())
            self.assertFalse((logs / "requests.jsonl").exists())
            self.assertFalse(old_slice.exists())

            # Running a second time on the same day must not overwrite the first slice
            (logs / "visitors.jsonl").write_text('{"b":3}\n', encoding="utf-8")
            rotated2 = stats.rotate_daily_logs(date_str="2026-11-24", compress=True)
            self.assertEqual(len(rotated2), 1)
            self.assertTrue((logs / "visitors-2026-11-24.1.jsonl.gz").is_file())
            lines = list(stats._iter_log_lines(str(logs / "visitors.jsonl")))
            self.assertEqual([ln.strip() for ln in lines], ['{"b":2}', '{"b":3}'])


class CommitBatchTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_module("u_commit_batch", "scripts/commit_batch.py")
        self.uid = os.getuid()
        self.gid = os.getgid()

    def _make_stage(self, root: Path, release_name: str, batch_id: str, content: bytes, bad_hash: bool = False):
        stage = root / f".u_pub.{release_name}"
        (stage / "files").mkdir(parents=True)
        fname = "sample.pdf"
        (stage / "files" / fname).write_bytes(content)
        digest = "0" * 64 if bad_hash else hashlib.sha256(content).hexdigest()
        req = {
            "batch": {
                "id": batch_id,
                "date": "2026-11-25",
                "title": "Test",
                "status": "latest",
                "lang_badge": "EN",
                "summary": "1 file",
                "files": [
                    {
                        "name": fname,
                        "path": f"batches/{batch_id}/{fname}",
                        "ext": "PDF",
                        "bytes": len(content),
                        "preview": True,
                    }
                ],
            },
            "keep_latest": False,
            "checksums": {fname: digest},
        }
        (stage / "batch.json").write_text(json.dumps(req), encoding="utf-8")
        return stage

    def test_commit_replaces_manifest_removes_gz_and_prunes_old_releases(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            base = root / "u"
            (base / "public").mkdir(parents=True)
            (base / "data" / "deliverables" / "batches").mkdir(parents=True)
            (base / "public" / "manifest.json").write_text(
                json.dumps({"version": 1, "updated_at": "", "batches": [], "references": []}),
                encoding="utf-8",
            )
            (base / "public" / "manifest.json.gz").write_bytes(b"stale-gz")

            for idx, rel in enumerate(("rel001", "rel002", "rel003")):
                stage = self._make_stage(root, rel, "demo", f"payload-{idx}".encode())
                self.mod.commit_batch(base, stage, self.uid, self.gid, keep_releases=2)

            self.assertFalse((base / "public" / "manifest.json.gz").exists())
            live = json.loads((base / "public" / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(live["batches"][0]["files"][0]["path"], "batches/demo/rel003/sample.pdf")

            batch_dir = base / "data" / "deliverables" / "batches" / "demo"
            remaining = sorted(p.name for p in batch_dir.iterdir() if p.is_dir())
            self.assertEqual(remaining, ["rel002", "rel003"])
            self.assertTrue((base / "data" / ".manifest-history" / "rel003.json").is_file())

    def test_checksum_mismatch_aborts_without_modifying_manifest(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            base = root / "u"
            (base / "public").mkdir(parents=True)
            (base / "data" / "deliverables" / "batches").mkdir(parents=True)
            orig = '{"version": 1, "batches": [], "references": []}\n'
            (base / "public" / "manifest.json").write_text(orig, encoding="utf-8")

            stage = self._make_stage(root, "bad001", "demo", b"real-data", bad_hash=True)
            with self.assertRaises(ValueError):
                self.mod.commit_batch(base, stage, self.uid, self.gid)

            self.assertEqual((base / "public" / "manifest.json").read_text(encoding="utf-8"), orig)
            self.assertFalse((base / "data" / "deliverables" / "batches" / "demo" / "bad001").exists())


class PublishHelpersTests(unittest.TestCase):
    def test_safe_filename_sanitizes_and_strips_upload_prefix(self):
        pub = load_module("u_publish_batch", "scripts/publish_batch.py")
        self.assertEqual(
            pub.safe_filename("20261124_000324_81d625_My Report (v2).pdf"),
            "My_Report_v2.pdf",
        )
        fallback = pub.safe_filename("....")
        self.assertTrue(fallback.startswith("file_"))


if __name__ == "__main__":
    unittest.main()
