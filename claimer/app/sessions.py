"""Session string / .session file / zip helpers.

Pure parsing/extraction only — koi Telegram se baat nahi karta yahan (koi connect/network call
nahi). Bot.py in candidates ko lekar client banata hai aur connect karta hai.
"""
import io
import os
import re
import tempfile
import zipfile

from telethon.sessions import SQLiteSession, StringSession

MAX_ENTRIES = 50
MAX_ENTRY_BYTES = 3 * 1024 * 1024  # 3MB: ek session file/string se zyada nahi hoti
SKIP_SUFFIXES = (".session-journal", ".session-wal", ".session-shm", ".journal")


def looks_like_string_session(s: str) -> bool:
    """True sirf tabhi jab ye ek valid Telethon string session lage (koi network call nahi)."""
    s = (s or "").strip()
    if not s or len(s) < 20:
        return False
    try:
        ss = StringSession(s)
    except Exception:
        return False
    return bool(ss.auth_key)


def sqlite_file_to_string(path: str) -> str:
    """.session (SQLite) file -> Telethon string session. Sirf local file padhta hai, network nahi."""
    base = path[:-8] if path.lower().endswith(".session") else path
    sq = SQLiteSession(base)
    try:
        ak = sq.auth_key
        if not ak:
            raise ValueError("is file me auth key nahi mila (corrupt ya khaali session)")
        ss = StringSession()
        ss.set_dc(sq.dc_id, sq.server_address, sq.port)
        ss.auth_key = ak
        return ss.save()
    finally:
        try:
            sq.close()
        except Exception:
            pass


def extract_candidates(filename: str, data: bytes) -> list[tuple[str, str]]:
    """(label, session_string) jodiyan nikalta hai: ek .session file, ek zip (kai sessions),
    ya plain text (ek ya kai lines, har line ek session string)."""
    out: list[tuple[str, str]] = []
    name = (filename or "file").lower()

    if name.endswith(".zip"):
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            return out
        names = [n for n in zf.namelist() if not n.endswith("/")][:MAX_ENTRIES]
        for n in names:
            if n.lower().endswith(SKIP_SUFFIXES):
                continue
            try:
                info = zf.getinfo(n)
                if info.file_size > MAX_ENTRY_BYTES:
                    continue
                content = zf.read(n)
            except Exception:
                continue
            out.extend(extract_candidates(os.path.basename(n), content))
        return out

    if name.endswith(".session"):
        if len(data) > MAX_ENTRY_BYTES:
            return out
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "acc.session")
            with open(p, "wb") as f:
                f.write(data)
            try:
                s = sqlite_file_to_string(p)
            except Exception:
                return out
        if looks_like_string_session(s):
            out.append((os.path.splitext(os.path.basename(filename or "session"))[0], s))
        return out

    # text / json / no-extension: ek ya kai lines, har line ek session string ho sakti hai
    try:
        text = data.decode("utf-8", "ignore")
    except Exception:
        return out
    base_label = os.path.splitext(os.path.basename(filename or "pasted"))[0]
    n = 0
    for line in re.split(r"[\r\n]+", text):
        line = line.strip().strip('",')
        if not line:
            continue
        if looks_like_string_session(line):
            n += 1
            label = base_label if n == 1 else f"{base_label}-{n}"
            out.append((label, line))
    return out
