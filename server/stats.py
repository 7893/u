#!/usr/bin/env python3
"""Aggregate /u access logs into stats.json. No database and no extra packages."""
import argparse
import bz2
import fcntl
import glob
import gzip
import json
import math
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta
from urllib.parse import unquote

def _install_root() -> str:
    env_root = os.environ.get("U_ROOT")
    if env_root:
        return env_root
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.basename(here) == "bin":
        return os.path.dirname(here)
    return os.getcwd()


ROOT = _install_root()
MANIFEST_PATH = f"{ROOT}/public/manifest.json"
STATS_PATH = f"{ROOT}/public/stats.json"
STATS_GZ_PATH = f"{ROOT}/public/stats.json.gz"
LOOP_LOCK_PATH = f"{ROOT}/data/.tmp/stats_loop.lock"
BUILD_LOCK_PATH = f"{ROOT}/data/.tmp/stats_build.lock"
ROTATE_LOCK_PATH = f"{ROOT}/data/.tmp/stats_rotate.lock"
INBOX_DIR = f"{ROOT}/data/inbox"
REQ_LOG = f"{ROOT}/logs/requests.jsonl"
VIS_LOG = f"{ROOT}/logs/visitors.jsonl"

UPLOAD_PREFIX_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_[0-9a-f]{6}_(.+)$")

def _env_value(path: str, wanted: str) -> str:
    if not path or not os.path.isfile(path):
        return ""
    try:
        handle = open(path, encoding="utf-8")
    except OSError:
        return ""
    with handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.strip() != wanted:
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            return value
    return ""


def load_legacy_map() -> dict:
    path = os.environ.get("U_LEGACY_MAP", f"{ROOT}/etc/legacy-map.json")
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        return {}
    return {str(key): str(value) for key, value in data.items()}


def load_excluded_ips() -> set:
    raw = os.environ.get("STATS_EXCLUDE_IPS", "")
    if not raw:
        raw = _env_value(os.environ.get("U_STATS_ENV", f"{ROOT}/etc/stats.env"), "STATS_EXCLUDE_IPS")
    if not raw:
        raw = _env_value(os.environ.get("U_ENV_FILE", f"{ROOT}/etc/u.env"), "STATS_EXCLUDE_IPS")
    return {item.strip() for item in raw.split(",") if item.strip()}


# Old top-level /u/<filename> routes. The map lives on the server, not in the repo.
LEGACY_MAP = load_legacy_map()

AUTOMATED_UA_RE = re.compile(
    r"(^curl/|HeadlessChrome|Playwright|Wget/|python-urllib|python-requests|Go-http-client)",
    re.IGNORECASE,
)

EXCLUDED_TEST_IPS = load_excluded_ips()
TERM_CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
REQ_RELEVANT_MARKERS = (
    b"/u/files/",
    b"/u/view/",
    b'"PUT"',
) + tuple(k.encode("utf-8") for k in LEGACY_MAP)


def sanitize_term(s) -> str:
    return TERM_CTRL_RE.sub(" ", str("" if s is None else s))


def safe_num(val):
    if isinstance(val, bool) or val is None:
        return None
    if isinstance(val, (int, float)):
        f = float(val)
        return f if math.isfinite(f) else None
    try:
        f = float(val)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def is_automated(ua: str) -> bool:
    return bool(ua and AUTOMATED_UA_RE.search(ua))


def is_excluded(ua: str, ip: str, include_automated: bool) -> bool:
    if include_automated:
        return False
    return is_automated(ua) or (ip in EXCLUDED_TEST_IPS)


def _entry_epoch(d: dict) -> float:
    m = safe_num(d.get("msec"))
    if m is not None and m > 0:
        return m
    ts = d.get("ts")
    if isinstance(ts, str) and ts:
        try:
            return datetime.fromisoformat(ts).timestamp()
        except Exception:
            pass
    return 0.0


def load_manifest():
    if not os.path.isfile(MANIFEST_PATH):
        return {"version": 1, "batches": [], "references": []}
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _discover_log_archives(base_path: str):
    """Discover rotated/daily-sliced archives for base_path, sorted oldest to newest."""
    log_dir = os.path.dirname(base_path) or "."
    base_name = os.path.basename(base_path)
    stem, ext = os.path.splitext(base_name)
    if not os.path.isdir(log_dir):
        return []

    numbered_re = re.compile(rf"^{re.escape(base_name)}\.(\d+)(?:\.(gz|bz2))?$")
    dateext_re = re.compile(
        rf"^{re.escape(base_name)}[.-](\d{{4}})-?(\d{{2}})-?(\d{{2}})(?:\.(\d+))?(?:\.(gz|bz2))?$"
    )
    daily_re = re.compile(
        rf"^{re.escape(stem)}-(\d{{4}})-(\d{{2}})-(\d{{2}})(?:\.(\d+))?{re.escape(ext)}(?:\.(gz|bz2))?$"
    )

    found = []
    try:
        entries = list(os.scandir(log_dir))
    except OSError:
        return []

    for entry in entries:
        if not entry.is_file():
            continue
        name = entry.name
        if name == base_name:
            continue

        m = daily_re.match(name)
        if m:
            day = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
            seq = int(m.group(4)) if m.group(4) else 0
            found.append(((1, day, seq, name), entry.path))
            continue

        m = dateext_re.match(name)
        if m:
            day = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
            seq = int(m.group(4)) if m.group(4) else 0
            found.append(((1, day, seq, name), entry.path))
            continue

        m = numbered_re.match(name)
        if m:
            num = int(m.group(1))
            found.append(((0, f"{99999999 - num:08d}", 0, name), entry.path))

    found.sort(key=lambda item: item[0])
    return [path for _, path in found]


def _open_log_text(path: str):
    if path.endswith(".bz2"):
        return bz2.open(path, "rt", encoding="utf-8", errors="replace")
    if path.endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def _iter_log_lines(base_path: str, max_archives: int | None = None):
    """Yield lines from rotated/daily archives (.jsonl/.gz/.bz2, oldest first) followed by live log."""
    archives = _discover_log_archives(base_path)
    if max_archives is not None and max_archives >= 0:
        archives = archives[-max_archives:] if max_archives > 0 else []
    for arch_path in archives:
        try:
            with _open_log_text(arch_path) as f:
                yield from f
        except OSError:
            continue
    if os.path.exists(base_path):
        try:
            with open(base_path, "r", encoding="utf-8", errors="replace") as f:
                yield from f
        except OSError:
            pass


def parse_requests(include_automated: bool = False):
    downloads = defaultdict(int)
    previews = defaultdict(int)
    dl_ips = defaultdict(set)
    pv_ips = defaultdict(set)
    last_dl = {}
    last_pv = {}
    last_206_ts = {}

    for line in _iter_log_lines(REQ_LOG):
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if not isinstance(d, dict):
            continue

        if d.get("method") != "GET":
            continue
        status = d.get("status")
        if status not in (200, 206):
            continue
        body_b = safe_num(d.get("body_bytes"))
        if body_b is None or body_b <= 0:
            continue
        bot_flag = safe_num(d.get("bot_flag"))
        if bot_flag is not None and bot_flag != 0:
            continue

        ip = str(d.get("ip") or "-")
        ua = str(d.get("ua") or "")
        if is_excluded(ua, ip, include_automated):
            continue

        uri = unquote(str(d.get("uri") or "").split("?")[0])
        ts = str(d.get("ts") or "")
        ts_epoch = _entry_epoch(d)

        if uri.startswith("/u/files/"):
            rel = uri[len("/u/files/"):]
            if status == 206 and ts_epoch > 0:
                key = (ip, rel)
                prev_ts = last_206_ts.get(key)
                last_206_ts[key] = ts_epoch
                if prev_ts is not None and 0 <= (ts_epoch - prev_ts) <= 60.0:
                    continue
            downloads[rel] += 1
            dl_ips[rel].add(ip)
            last_dl[rel] = ts
        elif uri.startswith("/u/view/"):
            if status == 206:
                continue
            rel = uri[len("/u/view/"):]
            previews[rel] += 1
            pv_ips[rel].add(ip)
            last_pv[rel] = ts
        elif uri in LEGACY_MAP:
            rel = LEGACY_MAP[uri]
            if status == 206 and ts_epoch > 0:
                key = (ip, rel)
                prev_ts = last_206_ts.get(key)
                last_206_ts[key] = ts_epoch
                if prev_ts is not None and 0 <= (ts_epoch - prev_ts) <= 60.0:
                    continue
            downloads[rel] += 1
            dl_ips[rel].add(ip)
            last_dl[rel] = ts

    return downloads, previews, dl_ips, pv_ips, last_dl, last_pv


def scan_inbox_receipts(limit: int = 50):
    """Scan inbox (pending) and inbox/archive (archived) to build read-only receipts."""
    items = []
    if not os.path.isdir(INBOX_DIR):
        return items

    def parse_entry(full_path: str, fname: str, status: str):
        if fname.startswith((".", "_")):
            return
        try:
            st = os.stat(full_path)
        except OSError:
            return
        m = UPLOAD_PREFIX_RE.match(fname)
        clean = m.group(7) if m else fname
        dt = datetime.fromtimestamp(st.st_mtime).astimezone()
        ts_str = dt.strftime("%Y-%m-%d %H:%M")
        items.append({
            "_sort": st.st_mtime_ns,
            "name": clean.strip(),
            "ts": ts_str,
            "bytes": int(st.st_size),
            "status": status,
        })

    # Pending files directly inside inbox/
    try:
        for entry in os.scandir(INBOX_DIR):
            if entry.is_file():
                parse_entry(entry.path, entry.name, "pending")
    except OSError:
        pass

    # Archived source files inside inbox/archive/*
    arch_root = os.path.join(INBOX_DIR, "archive")
    if os.path.isdir(arch_root):
        for dp, _, fns in os.walk(arch_root):
            for fn in fns:
                parse_entry(os.path.join(dp, fn), fn, "archived")

    # Sort: pending first, then newest server mtime first
    pending = sorted([x for x in items if x["status"] == "pending"], key=lambda x: x["_sort"], reverse=True)
    archived = sorted([x for x in items if x["status"] != "pending"], key=lambda x: x["_sort"], reverse=True)
    out = []
    for x in (pending + archived)[:limit]:
        out.append({
            "name": x["name"],
            "ts": x["ts"],
            "bytes": x["bytes"],
            "status": x["status"],
        })
    return out


class _StatsLock:
    def __init__(self, lock_path: str = BUILD_LOCK_PATH, blocking: bool = True):
        self.lock_path = lock_path
        self.blocking = blocking
        self.fd = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.lock_path), exist_ok=True)
        self.fd = open(self.lock_path, "w")
        flags = fcntl.LOCK_EX if self.blocking else (fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            fcntl.flock(self.fd.fileno(), flags)
        except BaseException:
            self.fd.close()
            self.fd = None
            raise
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.fd is not None:
            try:
                fcntl.flock(self.fd.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass
            self.fd.close()
            self.fd = None


def _build_stats_json_unlocked():
    manifest = load_manifest()
    downloads, _, _, _, _, _ = parse_requests(include_automated=False)
    receipts = scan_inbox_receipts()

    known_paths = []
    for b in manifest.get("batches", []):
        for item in b.get("files", []):
            known_paths.append(item["path"])
    for r in manifest.get("references", []):
        known_paths.append(r["path"])

    dl_map = {p: int(downloads.get(p, 0)) for p in known_paths}

    payload = {
        "downloads": dl_map,
        "total_downloads": sum(dl_map.values()),
        "receipts": receipts,
    }
    new_core = json.dumps(payload, ensure_ascii=False, sort_keys=True)

    # Remove any legacy precompressed copy so Nginx always serves the fresh JSON.
    if os.path.exists(STATS_GZ_PATH):
        try:
            os.unlink(STATS_GZ_PATH)
        except OSError:
            pass

    # Skip disk write if counts & receipts haven't changed
    if os.path.exists(STATS_PATH):
        try:
            with open(STATS_PATH, "r", encoding="utf-8") as f:
                old = json.load(f)
            old_core = json.dumps(
                {
                    "downloads": old.get("downloads", {}),
                    "total_downloads": old.get("total_downloads", 0),
                    "receipts": old.get("receipts", []),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
            if old_core == new_core:
                return False
        except Exception:
            pass

    out_obj = {
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "total_downloads": payload["total_downloads"],
        "downloads": dl_map,
        "receipts": receipts,
    }
    raw_bytes = (json.dumps(out_obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")

    tmp_json = f"{STATS_PATH}.tmp.{os.getpid()}"
    try:
        with open(tmp_json, "wb") as f:
            f.write(raw_bytes)
        os.chmod(tmp_json, 0o644)
        os.replace(tmp_json, STATS_PATH)
    finally:
        if os.path.exists(tmp_json):
            try:
                os.unlink(tmp_json)
            except OSError:
                pass
    return True


def build_stats_json(hold_lock: bool = True):
    if hold_lock:
        with _StatsLock(blocking=True):
            return _build_stats_json_unlocked()
    return _build_stats_json_unlocked()


def short_ua(ua: str) -> str:
    if not ua:
        return "-"
    os_name = "Other"
    if "iPhone" in ua:
        os_name = "iPhone"
    elif "iPad" in ua:
        os_name = "iPad"
    elif "Android" in ua:
        os_name = "Android"
    elif "Macintosh" in ua or "Mac OS X" in ua:
        os_name = "macOS"
    elif "Windows" in ua:
        os_name = "Windows"
    elif "Linux" in ua:
        os_name = "Linux"

    br = "Browser"
    if "MicroMessenger" in ua:
        br = "WeChat"
    elif "Edg/" in ua:
        br = "Edge"
    elif "Chrome/" in ua:
        br = "Chrome"
    elif "Firefox/" in ua:
        br = "Firefox"
    elif "Safari/" in ua:
        br = "Safari"
    return f"{os_name}/{br}"


def print_report(include_automated: bool = False, recent_sessions: int = 12):
    manifest = load_manifest()
    downloads, previews, dl_ips, pv_ips, last_dl, last_pv = parse_requests(include_automated=include_automated)

    print("=" * 78)
    print(f"  /u/ 交付下载与访问统计报表  ({datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')})")
    print("=" * 78)

    total_dl = 0
    total_pv = 0
    for b in manifest.get("batches", []):
        tag = "最新" if b.get("status") == "latest" else "归档"
        print(f"\n[{tag}] {b.get('date','')} · {b.get('title','')}")
        print(f"  {'文件名':<52} {'下载':>4} {'IP':>3} {'预览':>4}  {'最近下载时间'}")
        print("  " + "-" * 74)
        for item in b.get("files", []):
            p = item["path"]
            dl = downloads.get(p, 0)
            pv = previews.get(p, 0)
            ips = len(dl_ips.get(p, set()))
            lts = (last_dl.get(p) or "-")[:19].replace("T", " ")
            name = item["name"]
            if len(name) > 50:
                name = name[:47] + "..."
            total_dl += dl
            total_pv += pv
            print(f"  {name:<52} {dl:>4} {ips:>3} {pv:>4}  {lts}")

    refs = manifest.get("references", [])
    if refs:
        print("\n[参考资料]")
        print(f"  {'文件名':<52} {'下载':>4} {'IP':>3} {'预览':>4}  {'最近下载时间'}")
        print("  " + "-" * 74)
        for item in refs:
            p = item["path"]
            dl = downloads.get(p, 0)
            ips = len(dl_ips.get(p, set()))
            lts = (last_dl.get(p) or "-")[:19].replace("T", " ")
            total_dl += dl
            print(f"  {item['name']:<52} {dl:>4} {ips:>3} {'-':>4}  {lts}")

    print("\n" + "-" * 78)
    print(f"  合计：真实下载 {total_dl} 次 | 在线预览 {total_pv} 次")
    print("=" * 78)

    # Summarize recent real visitor sessions from visitors.jsonl (+ recent daily/rotated archives)
    sessions = {}
    order = []
    for line in _iter_log_lines(VIS_LOG, max_archives=7):
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
            if not isinstance(d, dict):
                continue
            ip = sanitize_term(d.get("ip") or "-")
            ua = sanitize_term(d.get("ua") or "")
            if is_excluded(ua, ip, include_automated):
                continue
            ev = sanitize_term(d.get("event") or "")
            if ev == "migration_check":
                continue
            ts_s = sanitize_term(str(d.get("ts") or "")[:19].replace("T", " "))
            sid = sanitize_term(d.get("sid") or f"{ip}:{ts_s[:13]}")
            if sid not in sessions:
                sessions[sid] = {
                    "ts": ts_s,
                    "ip": ip,
                    "ua": sanitize_term(short_ua(ua)),
                    "events": [],
                    "files": [],
                    "dwell_s": 0,
                }
                order.append(sid)
            s = sessions[sid]
            s["events"].append(ev)
            raw_payload = d.get("payload") or ""
            if raw_payload and isinstance(raw_payload, str):
                try:
                    pl = json.loads(raw_payload)
                except Exception:
                    pl = None
                if isinstance(pl, dict):
                    dm = safe_num(pl.get("dwell_ms"))
                    if dm is not None and dm / 1000.0 > s["dwell_s"]:
                        s["dwell_s"] = round(dm / 1000.0)
                    det = pl.get("detail")
                    if isinstance(det, dict):
                        fn = det.get("filename") or det.get("name")
                        if fn and ev in ("pdf_download", "file_download", "file_preview", "file_uploaded"):
                            s["files"].append(f"{ev}:{sanitize_term(fn)}")
        except Exception:
            continue

    if order:
        print(f"\n最近 {min(recent_sessions, len(order))} 次活跃访客会话（来自 visitors.jsonl）：")
        for sid in order[-recent_sessions:][::-1]:
            s = sessions[sid]
            ev_uniq = sanitize_term(",".join(dict.fromkeys(s["events"])))
            f_str = f" | 文件: {', '.join(s['files'][:3])}" + ("..." if len(s["files"]) > 3 else "") if s["files"] else ""
            print(f"  {s['ts']} | {s['ip']:<15} | {s['ua']:<15} | 停留 {s['dwell_s']:>3}s | {ev_uniq}{f_str}")


def _non_req_sig():
    paths = [MANIFEST_PATH, INBOX_DIR]
    arch_root = os.path.join(INBOX_DIR, "archive")
    if os.path.isdir(arch_root):
        for dp, _, _ in sorted(os.walk(arch_root)):
            paths.append(dp)
    else:
        paths.append(arch_root)
    sig_parts = []
    for p in paths:
        try:
            st = os.stat(p)
            sig_parts.append((p, st.st_ino, st.st_size, st.st_mtime_ns))
        except FileNotFoundError:
            sig_parts.append((p, None))
    return tuple(sig_parts)


def run_build_loop(duration_sec: int = 56, interval_sec: float = 2.0):
    try:
        lock = _StatsLock(lock_path=LOOP_LOCK_PATH, blocking=False)
        lock.__enter__()
    except BlockingIOError:
        return

    try:
        t0 = time.monotonic()
        last_other_sig = None
        req_inode = None
        req_offset = 0
        first_run = True
        while True:
            other_sig = _non_req_sig()
            need_build = first_run or (other_sig != last_other_sig)

            try:
                st = os.stat(REQ_LOG)
                cur_ino, cur_size = st.st_ino, st.st_size
                if req_inode is None:
                    req_inode = cur_ino
                    req_offset = cur_size
                elif cur_ino != req_inode or cur_size < req_offset:
                    req_inode = cur_ino
                    req_offset = cur_size
                    need_build = True
                elif cur_size > req_offset:
                    with open(REQ_LOG, "rb") as rf:
                        rf.seek(req_offset)
                        chunk = rf.read(cur_size - req_offset)
                    nl = chunk.rfind(b"\n")
                    if nl >= 0:
                        complete = chunk[:nl + 1]
                        req_offset += len(complete)
                        if not need_build and any(m in complete for m in REQ_RELEVANT_MARKERS):
                            need_build = True
            except FileNotFoundError:
                if req_inode is not None:
                    req_inode = None
                    req_offset = 0
                    need_build = True

            if need_build:
                build_stats_json(hold_lock=True)
                last_other_sig = other_sig
                first_run = False
            if time.monotonic() - t0 >= duration_sec:
                break
            time.sleep(interval_sec)
    finally:
        lock.__exit__(None, None, None)


def fmt_bytes_short(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1048576:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1048576:.2f} MB"


def print_timeline(hours: float = 24.0, filter_vid: str = "", filter_ip: str = "", include_automated: bool = False):
    cutoff_epoch = time.time() - hours * 3600.0
    events = []

    manifest = load_manifest()
    expected_bytes = {}
    for b in manifest.get("batches", []):
        for it in b.get("files", []):
            expected_bytes[it["path"]] = it.get("bytes", 0)
    for it in manifest.get("references", []):
        expected_bytes[it["path"]] = it.get("bytes", 0)

    arch_limit = max(2, math.ceil(max(hours, 0.0) / 24.0) + 1)

    # 1. Server-side transfers from requests.jsonl (+ recent daily/rotated archives)
    for line in _iter_log_lines(REQ_LOG, max_archives=arch_limit):
        try:
            d = json.loads(line)
            if not isinstance(d, dict):
                continue
            msec = safe_num(d.get("msec")) or 0.0
            if msec < cutoff_epoch:
                continue
            ip = sanitize_term(d.get("ip") or "-")
            if filter_ip and ip != filter_ip:
                continue
            if filter_vid:
                continue  # requests.jsonl has no vid; skip only if user explicitly filtered by vid
            ua = sanitize_term(d.get("ua") or "")
            if is_excluded(ua, ip, include_automated):
                continue

            method = d.get("method")
            uri = unquote(str(d.get("uri") or "").split("?")[0])
            status = d.get("status")
            body_b = int(safe_num(d.get("body_bytes")) or 0)
            req_t = safe_num(d.get("req_time_s")) or 0.0
            ts_s = sanitize_term(str(d.get("ts") or "")[:19].replace("T", " "))

            if method == "PUT" and status in (201, 204):
                fname = uri.split("/")[-1]
                m = UPLOAD_PREFIX_RE.match(fname)
                clean = sanitize_term(m.group(7) if m else fname)
                req_b = int(safe_num(d.get("req_bytes")) or 0)
                events.append((msec, ts_s, ip, "-", sanitize_term(short_ua(ua)), "上传完成", f"{clean} ({fmt_bytes_short(req_b)}, {req_t:.1f}s)"))
            elif method == "GET" and status in (200, 206) and body_b > 0:
                rel = None
                kind = None
                if uri.startswith("/u/files/"):
                    rel = uri[len("/u/files/"):]
                    kind = "真实下载"
                elif uri.startswith("/u/view/"):
                    if status == 206:
                        continue  # Skip noisy PDF.js HTTP Range stream chunks; pdf_view_open records load_ms
                    rel = uri[len("/u/view/"):]
                    kind = "PDF加载"
                elif uri in LEGACY_MAP:
                    rel = LEGACY_MAP[uri]
                    kind = "历史下载"
                if rel:
                    exp = expected_bytes.get(rel, 0)
                    if not exp or body_b >= exp * 0.99:
                        completeness = "完整"
                    elif status == 206:
                        completeness = f"分段 {body_b*100//exp}%"
                    elif kind == "PDF加载" and status == 200:
                        completeness = f"首段流式 {body_b*100//exp}%"
                    else:
                        completeness = f"中断 {body_b*100//exp}%"
                    spd = f", {body_b/1024/req_t:.0f} KB/s" if req_t >= 0.2 else ""
                    events.append((msec, ts_s, ip, "-", sanitize_term(short_ua(ua)), kind, f"{sanitize_term(os.path.basename(rel))} ({fmt_bytes_short(body_b)} {completeness}, {req_t:.1f}s{spd})"))
        except Exception:
            continue

    # 2. Client-side behavioral trail from visitors.jsonl (+ recent daily/rotated archives)
    for line in _iter_log_lines(VIS_LOG, max_archives=arch_limit):
        try:
            d = json.loads(line)
            if not isinstance(d, dict):
                continue
            msec = safe_num(d.get("msec")) or 0.0
            if msec < cutoff_epoch:
                continue
            ip = sanitize_term(d.get("ip") or "-")
            vid = sanitize_term(d.get("vid") or "-")
            if filter_ip and ip != filter_ip:
                continue
            if filter_vid and not vid.startswith(filter_vid):
                continue
            ua = sanitize_term(d.get("ua") or "")
            ev = sanitize_term(d.get("event") or "")
            if ev == "migration_check":
                continue
            if is_excluded(ua, ip, include_automated):
                continue

            ts_s = sanitize_term(str(d.get("ts") or "")[:19].replace("T", " "))
            pl = {}
            raw_pl = d.get("payload")
            if isinstance(raw_pl, str) and raw_pl:
                try:
                    parsed_pl = json.loads(raw_pl)
                    if isinstance(parsed_pl, dict):
                        pl = parsed_pl
                except Exception:
                    pass
            det_raw = pl.get("detail")
            det = det_raw if isinstance(det_raw, dict) else {}
            dwell_ms = safe_num(pl.get("dwell_ms")) or 0.0
            dwell_s = round(dwell_ms / 1000.0, 1)

            label = ev
            desc = ""
            if ev == "page_open":
                label = "打开页面"
                desc = f"状态={sanitize_term(det.get('initial_state'))}"
            elif ev == "auth_ok":
                label = "口令通过"
                desc = f"第 {sanitize_term(det.get('attempt', 1))} 次尝试"
            elif ev == "auth_fail":
                label = "口令错误"
                wi = det.get("wrong_input")
                if wi:
                    desc = f"第 {sanitize_term(det.get('attempt'))} 次, 输入='{sanitize_term(wi)}'"
                else:
                    ilen = det.get("input_len")
                    ilen_s = f", 长度={sanitize_term(ilen)}" if ilen is not None else ""
                    desc = f"第 {sanitize_term(det.get('attempt'))} 次{ilen_s}"
            elif ev == "tab_switch":
                label = "切换分类"
                desc = f"tab={sanitize_term(det.get('tab'))} (命中 {sanitize_term(det.get('results'))} 项)"
            elif ev == "search_query":
                label = "搜索筛选"
                desc = f"词='{sanitize_term(det.get('q'))}' (命中 {sanitize_term(det.get('results'))} 项)"
            elif ev == "batch_toggle":
                label = "展开批次" if det.get("open") else "收起批次"
                desc = f"{sanitize_term(det.get('batch_id'))} ({sanitize_term(det.get('title', ''))})"
            elif ev == "receipt_toggle":
                label = "展开回执" if det.get("open") else "收起回执"
                desc = f"{sanitize_term(det.get('count', 0))} 份记录"
            elif ev == "scroll_depth":
                label = "页面滚动"
                desc = f"已滚至 {sanitize_term(det.get('milestone_pct'))}%"
            elif ev == "text_copy":
                label = "复制文字"
                desc = f"'{sanitize_term(str(det.get('text', ''))[:80])}'"
            elif ev == "picker_open":
                label = "打开选文件"
                desc = f"当前队列 {sanitize_term(det.get('queue_count', 0))}"
            elif ev == "picker_cancel":
                label = "取消选文件"
                desc = "未选择任何文件"
            elif ev == "viewport_resize":
                label = "窗口/屏幕变化"
                desc = (
                    f"视口 {sanitize_term(det.get('inner_w'))}x{sanitize_term(det.get('inner_h'))} "
                    f"@{sanitize_term(det.get('dpr'))}x (屏 {sanitize_term(det.get('screen_w'))}x{sanitize_term(det.get('screen_h'))})"
                )
            elif ev == "tab_return":
                label = "切回前台"
                away = safe_num(det.get("away_ms"))
                away_s = f"离开 {away/1000:.1f}s" if away is not None else ""
                desc = f"{away_s} (累计切换 {sanitize_term(det.get('tab_switches', 0))} 次)".strip()
            elif ev == "pdf_view_open":
                label = "打开阅读器"
                lms = safe_num(det.get("load_ms"))
                load_s = f", 首屏加载 {lms/1000:.1f}s" if lms is not None else ""
                desc = f"{sanitize_term(det.get('filename'))} (共 {sanitize_term(det.get('total_pages'))} 页{load_s})"
            elif ev == "pdf_search":
                label = "文档搜索"
                desc = f"{sanitize_term(det.get('filename'))} 词='{sanitize_term(det.get('q', ''))}' (命中 {sanitize_term(det.get('hits', 0))} 处)"
            elif ev == "pdf_page_milestone":
                label = "阅读进度"
                desc = (
                    f"{sanitize_term(det.get('filename'))} 达 {sanitize_term(det.get('milestone_pct'))}% "
                    f"({sanitize_term(det.get('pages_viewed'))}/{sanitize_term(det.get('total_pages'))} 页, 当前第 {sanitize_term(det.get('current_page'))} 页)"
                )
            elif ev in ("pdf_view_close", "pdf_view_pause"):
                label = "结束阅读" if ev == "pdf_view_close" else "暂停阅读"
                pd_raw = det.get("page_dwell_s")
                pd_items = []
                if isinstance(pd_raw, dict):
                    for k, v in pd_raw.items():
                        nv = safe_num(v)
                        if nv is not None:
                            pd_items.append((sanitize_term(k), nv))
                top_p = sorted(pd_items, key=lambda kv: kv[1], reverse=True)[:5]
                top_s = ", ".join(f"p{k}:{v:g}s" for k, v in top_p)
                read_ms = safe_num(det.get("read_ms")) or 0.0
                desc = (
                    f"{sanitize_term(det.get('filename'))} | 读 {sanitize_term(det.get('pages_viewed'))}/{sanitize_term(det.get('total_pages'))} 页"
                    f"({sanitize_term(det.get('completion_pct'))}%, 最远p{sanitize_term(det.get('max_page'))}) | "
                    f"阅读 {read_ms/1000:.1f}s"
                    + (f" | 停留最多: {top_s}" if top_s else "")
                )
            elif ev in ("file_download", "pdf_download"):
                label = "点击下载"
                desc = f"{sanitize_term(det.get('filename'))}"
            elif ev == "file_preview":
                label = "点击预览"
                desc = f"{sanitize_term(det.get('filename'))} ({sanitize_term(det.get('mode', 'default'))})"
            elif ev == "page_leave":
                label = "切走/关闭"
                act = safe_num(det.get("active_ms"))
                act_s = f", 活跃 {act/1000:.1f}s" if act is not None else ""
                scr = safe_num(det.get("max_scroll_pct"))
                scr_s = f", 滚动 {scr:g}%" if scr is not None and scr > 0 else ""
                desc = f"{sanitize_term(det.get('reason'))} (停留 {dwell_s}s{act_s}{scr_s})"
            else:
                desc = sanitize_term(json.dumps(det, ensure_ascii=False)[:100]) if det else ""

            events.append((msec, ts_s, ip, vid[:8], sanitize_term(short_ua(ua)), sanitize_term(label), sanitize_term(desc)))
        except Exception:
            continue

    events.sort(key=lambda x: x[0])
    print("=" * 96)
    f_note = f" | VID={sanitize_term(filter_vid)}" if filter_vid else ""
    f_note += f" | IP={sanitize_term(filter_ip)}" if filter_ip else ""
    print(f"  /u/ 合并行为时间线（近 {hours:g} 小时 · 共 {len(events)} 条{f_note}）")
    print("=" * 96)
    for _, ts_s, ip, vid8, uas, label, desc in events:
        print(f"  {ts_s} | {ip:<15} | {vid8:<8} | {uas:<14} | {label:<8} | {desc}")


def rotate_daily_logs(date_str: str = "", compress: bool = False, keep_days: int = 0):
    """Slice live requests.jsonl & visitors.jsonl into daily YYYY-MM-DD files.

    Callers should signal Nginx to reopen logs afterwards (e.g. `nginx -s reopen`
    or SIGUSR1) so Nginx creates fresh live files.
    """
    if date_str:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_str):
            raise ValueError(f"Invalid --date '{date_str}': expected YYYY-MM-DD")
        label = date_str
    else:
        label = (datetime.now().astimezone() - timedelta(days=1)).strftime("%Y-%m-%d")

    rotated = []
    with _StatsLock(blocking=True):
        for live_path in (REQ_LOG, VIS_LOG):
            if not os.path.isfile(live_path):
                continue
            try:
                st = os.stat(live_path)
            except OSError:
                continue
            if st.st_size == 0:
                continue

            log_dir = os.path.dirname(live_path) or "."
            stem, ext = os.path.splitext(os.path.basename(live_path))
            suffix = ".gz" if compress else ""
            candidate = os.path.join(log_dir, f"{stem}-{label}{ext}{suffix}")
            idx = 1
            while os.path.exists(candidate) or os.path.exists(
                os.path.join(log_dir, f"{stem}-{label}.{idx}{ext}")
                if idx > 1
                else os.path.join(log_dir, f"{stem}-{label}{ext}")
            ):
                candidate = os.path.join(log_dir, f"{stem}-{label}.{idx}{ext}{suffix}")
                idx += 1

            if compress:
                plain_tmp = os.path.join(log_dir, f".{stem}-{label}.rot.{os.getpid()}")
                gz_tmp = f"{candidate}.tmp.{os.getpid()}"
                os.replace(live_path, plain_tmp)
                try:
                    with open(plain_tmp, "rb") as src, gzip.open(gz_tmp, "wb", compresslevel=6) as dst:
                        while True:
                            chunk = src.read(65536)
                            if not chunk:
                                break
                            dst.write(chunk)
                    try:
                        os.chown(gz_tmp, st.st_uid, st.st_gid)
                    except PermissionError:
                        pass
                    os.chmod(gz_tmp, st.st_mode & 0o7777)
                    os.replace(gz_tmp, candidate)
                    os.unlink(plain_tmp)
                except BaseException:
                    if os.path.exists(gz_tmp):
                        try:
                            os.unlink(gz_tmp)
                        except OSError:
                            pass
                    raise
            else:
                os.replace(live_path, candidate)
                os.chmod(candidate, st.st_mode & 0o7777)

            rotated.append(candidate)

            if keep_days > 0:
                cutoff = (datetime.now().astimezone() - timedelta(days=keep_days)).strftime("%Y-%m-%d")
                daily_re = re.compile(
                    rf"^{re.escape(stem)}-(\d{{4}}-\d{{2}}-\d{{2}})(?:\.\d+)?{re.escape(ext)}(?:\.(?:gz|bz2))?$"
                )
                for entry in os.scandir(log_dir):
                    if not entry.is_file():
                        continue
                    m = daily_re.match(entry.name)
                    if m and m.group(1) < cutoff:
                        try:
                            os.unlink(entry.path)
                        except OSError:
                            pass

    return rotated


def main():
    ap = argparse.ArgumentParser(description="/u/ download stats builder & admin report")
    ap.add_argument("--build", action="store_true", help="Rebuild stats.json once")
    ap.add_argument("--build-loop", action="store_true", help="Watch requests.jsonl every 2s for 56s (cron-safe)")
    ap.add_argument("--rotate-daily", action="store_true", help="Slice live JSONL logs into YYYY-MM-DD archive files")
    ap.add_argument("--date", default="", help="Override archive date for --rotate-daily (YYYY-MM-DD; default yesterday)")
    ap.add_argument("--compress", action="store_true", help="Gzip daily slices created by --rotate-daily")
    ap.add_argument("--keep-days", type=int, default=0, help="Prune daily slices older than N days (0 keeps all)")
    ap.add_argument("--report", action="store_true", help="Print admin download & visitor report")
    ap.add_argument("--timeline", action="store_true", help="Print merged chronological user behavior timeline")
    ap.add_argument("--hours", type=float, default=24.0, help="Hours lookback for --timeline (default: 24)")
    ap.add_argument("--vid", default="", help="Filter --timeline by VID prefix")
    ap.add_argument("--ip", default="", help="Filter --timeline by IP address")
    ap.add_argument("--include-automated", action="store_true", help="Include curl/headless test requests")
    args = ap.parse_args()

    if not args.build and not args.build_loop and not args.rotate_daily and not args.report and not args.timeline:
        args.report = True

    if args.rotate_daily:
        sliced = rotate_daily_logs(date_str=args.date, compress=args.compress, keep_days=args.keep_days)
        for path in sliced:
            print(f"[rotate] {path}")
        if not sliced:
            print("[rotate] no non-empty logs to slice")
        if not (args.build or args.build_loop or args.report or args.timeline):
            return

    if args.build_loop:
        run_build_loop()
        return

    if args.build:
        changed = build_stats_json()
        if args.report or args.timeline:
            print(f"[build] stats.json {'updated' if changed else 'unchanged'}\n")
    if args.report:
        print_report(include_automated=args.include_automated)
    if args.timeline:
        print_timeline(
            hours=args.hours,
            filter_vid=args.vid,
            filter_ip=args.ip,
            include_automated=args.include_automated,
        )


if __name__ == "__main__":
    main()
