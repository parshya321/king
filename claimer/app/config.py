import base64
import hashlib
import os
from datetime import timedelta, timezone

from cryptography.fernet import Fernet

BOT_TOKEN = os.environ["BOT_TOKEN"]
API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]


def _data_dir() -> str:
    d = os.environ.get("DATA_DIR", "/data")
    try:
        os.makedirs(d, exist_ok=True)
        probe = os.path.join(d, ".w")
        open(probe, "w").close()
        os.remove(probe)
        return d
    except OSError:
        d = os.path.abspath("data")
        os.makedirs(d, exist_ok=True)
        return d


DATA_DIR = _data_dir()
DB_PATH = os.path.join(DATA_DIR, "bot.db")
IST = timezone(timedelta(hours=5, minutes=30))

# Sessions DB me encrypted rehte hain (key = BOT_TOKEN + API_HASH se).
_fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256((BOT_TOKEN + API_HASH).encode()).digest()))


def enc(s: str) -> str:
    return _fernet.encrypt(s.encode()).decode()


def dec(s: str) -> str:
    return _fernet.decrypt(s.encode()).decode()


DEFAULTS = {
    "target": "",      # username jo chahiye (bina @)
    "sched": "",       # "HH:MM:SS[.mmm]" ya "DD-MM-YYYY HH:MM:SS[.mmm]" (IST)
    "gap_ms": "500",   # har account ke 2 tries ke beech ka gap
    "window_s": "120", # schedule time ke baad kitni der try karna hai
    "max_att": "0",    # per account max attempts (0 = unlimited)
    "lead_s": "15",    # schedule se kitna pehle accounts ready karne hain
    "notify": "1",
    "jitter_pct": "20", # gap me +/- itna % random (10s gap -> 8-12s). 0 = bilkul fixed
    "armed_forever": "",
}
