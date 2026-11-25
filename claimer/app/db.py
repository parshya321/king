import sqlite3
import threading

from .config import DEFAULTS


class DB:
    def __init__(self, path: str):
        self.c = sqlite3.connect(path, check_same_thread=False)
        self.c.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.c.executescript(
                """
                CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
                CREATE TABLE IF NOT EXISTS accounts(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tg_id INTEGER UNIQUE, phone TEXT, name TEXT,
                    session TEXT, channel_id INTEGER, active INTEGER DEFAULT 1);
                CREATE TABLE IF NOT EXISTS reports(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts REAL, text TEXT);
                """
            )
            # migration: twofa column (account ka cloud password, encrypted store hota hai)
            cols = [r["name"] for r in self.c.execute("PRAGMA table_info(accounts)").fetchall()]
            if "twofa" not in cols:
                self.c.execute("ALTER TABLE accounts ADD COLUMN twofa TEXT")
                self.c.commit()

    def get(self, k, default=None):
        with self.lock:
            r = self.c.execute("SELECT v FROM settings WHERE k=?", (k,)).fetchone()
        if r is not None:
            return r["v"]
        return DEFAULTS.get(k, default)

    def set(self, k, v):
        with self.lock:
            self.c.execute("INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)", (k, str(v)))
            self.c.commit()

    def int(self, k):
        return int(self.get(k) or 0)

    # accounts
    def upsert_account(self, tg_id, phone, name, session) -> int:
        with self.lock:
            r = self.c.execute("SELECT id FROM accounts WHERE tg_id=?", (tg_id,)).fetchone()
            if r:
                self.c.execute(
                    "UPDATE accounts SET phone=?, name=?, session=? WHERE id=?",
                    (phone, name, session, r["id"]),
                )
                self.c.commit()
                return r["id"]
            cur = self.c.execute(
                "INSERT INTO accounts(tg_id,phone,name,session) VALUES(?,?,?,?)",
                (tg_id, phone, name, session),
            )
            self.c.commit()
            return cur.lastrowid

    def accounts(self, only_active=False):
        q = "SELECT * FROM accounts" + (" WHERE active=1" if only_active else "") + " ORDER BY id"
        with self.lock:
            return [dict(r) for r in self.c.execute(q).fetchall()]

    def account(self, aid):
        with self.lock:
            r = self.c.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()
        return dict(r) if r else None

    def account_by_tg(self, tg_id):
        with self.lock:
            r = self.c.execute("SELECT * FROM accounts WHERE tg_id=?", (tg_id,)).fetchone()
        return dict(r) if r else None

    def update_account(self, aid, **kw):
        cols = ",".join(f"{k}=?" for k in kw)
        with self.lock:
            self.c.execute(f"UPDATE accounts SET {cols} WHERE id=?", (*kw.values(), aid))
            self.c.commit()

    def delete_account(self, aid):
        with self.lock:
            self.c.execute("DELETE FROM accounts WHERE id=?", (aid,))
            self.c.commit()

    # reports
    def add_report(self, ts, text):
        with self.lock:
            self.c.execute("INSERT INTO reports(ts,text) VALUES(?,?)", (ts, text))
            self.c.commit()

    def last_report(self):
        with self.lock:
            r = self.c.execute("SELECT text FROM reports ORDER BY id DESC LIMIT 1").fetchone()
        return r["text"] if r else None
