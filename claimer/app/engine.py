import asyncio
import html
import logging
import random
import re
import secrets
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from telethon import TelegramClient, errors
from telethon.sessions import StringSession
from telethon.tl.functions.account import UpdateUsernameRequest as AccUser
from telethon.tl.functions.channels import CreateChannelRequest
from telethon.tl.functions.channels import UpdateUsernameRequest as ChUser
from telethon.tl.types import Channel

from .config import API_HASH, API_ID, IST, dec

log = logging.getLogger("engine")

DEAD_ERRORS = ("AUTH_KEY", "SESSION_REVOKED", "USER_DEACTIVATED", "PHONE_NUMBER_BANNED")


def fmt_ts(ts: float) -> str:
    d = datetime.fromtimestamp(ts, IST)
    return d.strftime("%H:%M:%S.") + f"{d.microsecond // 1000:03d}"


def parse_sched(text: str):
    """'HH:MM:SS[.mmm]' ya 'DD-MM-YYYY HH:MM:SS[.mmm]' (IST). Returns (date|None, time) ya None."""
    text = text.strip()
    m = re.fullmatch(r"(?:(\d{1,2})-(\d{1,2})-(\d{4})\s+)?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?", text)
    if not m:
        return None
    dd, mm, yy, H, M, S, ms = m.groups()
    try:
        micro = int((ms or "0").ljust(3, "0")) * 1000
        t = datetime(2000, 1, 1, int(H), int(M), int(S), micro).time()
        d = datetime(int(yy), int(mm), int(dd)).date() if yy else None
    except ValueError:
        return None
    return d, t


def sched_epoch(text: str, now: float | None = None):
    p = parse_sched(text)
    if not p:
        return None
    d, t = p
    now = now or time.time()
    nowd = datetime.fromtimestamp(now, IST)
    if d:
        return datetime.combine(d, t, tzinfo=IST).timestamp()
    cand = datetime.combine(nowd.date(), t, tzinfo=IST)
    if cand.timestamp() <= now:
        cand += timedelta(days=1)
    return cand.timestamp()


@dataclass
class Stat:
    acc: dict
    client: TelegramClient
    channel: Channel
    attempts: int = 0
    errors: Counter = field(default_factory=Counter)
    floods: list = field(default_factory=list)
    first: float | None = None
    win: float | None = None
    win_attempt: int = 0
    paused_until: float = 0.0
    inflight: int = 0
    dead: bool = False

    @property
    def label(self):
        return self.acc.get("phone") or self.acc.get("name") or str(self.acc["id"])


class Engine:
    def __init__(self, db, notify):
        self.db = db
        self.notify = notify  # async fn(text, kb=None)
        self.clients: dict[int, TelegramClient] = {}
        self.task: asyncio.Task | None = None
        self.stop = asyncio.Event()
        self.offset = 0.0
        self.winner: Stat | None = None
        self.phase = "idle"  # idle | armed | preparing | running

    def now(self) -> float:
        return time.time() + self.offset

    # ---------- clients / channels ----------
    @staticmethod
    def make_client(session: str = "") -> TelegramClient:
        c = TelegramClient(StringSession(session), API_ID, API_HASH, request_retries=1)
        c.flood_sleep_threshold = 0  # FloodWait ko khud handle karenge, Telethon chup-chaap sleep na kare
        return c

    async def client_for(self, acc: dict) -> TelegramClient:
        c = self.clients.get(acc["id"])
        if c is None:
            c = self.make_client(dec(acc["session"]))
            self.clients[acc["id"]] = c
        if not c.is_connected():
            await c.connect()
        if not await c.is_user_authorized():
            raise RuntimeError("session logout ho gaya, account dobara add karo")
        return c

    def adopt_client(self, aid: int, client: TelegramClient):
        self.clients[aid] = client

    async def drop_client(self, aid: int):
        c = self.clients.pop(aid, None)
        if c:
            try:
                await c.disconnect()
            except Exception:
                pass

    @staticmethod
    def _temp_username() -> str:
        return "ch" + secrets.token_hex(6)

    async def _make_public(self, client, ch: Channel) -> Channel:
        if not ch.username:
            await client(ChUser(ch, self._temp_username()))
            ch = await client.get_entity(ch)
        return ch

    async def ensure_channel(self, acc: dict, client: TelegramClient) -> tuple[Channel, str]:
        """Public channel dhoondo (saved ya existing), warna nayi banao."""
        dialogs = [d.entity async for d in client.iter_dialogs(limit=300) if isinstance(d.entity, Channel)]
        owned = [e for e in dialogs if e.broadcast and e.creator]
        if acc.get("channel_id"):
            for e in owned:
                if e.id == acc["channel_id"]:
                    return await self._make_public(client, e), "saved channel"
        for e in owned:
            if e.username:
                self.db.update_account(acc["id"], channel_id=e.id)
                return e, "existing public channel mili"
        res = await client(CreateChannelRequest(title="Notes", about="", broadcast=True))
        ch = await self._make_public(client, res.chats[0])
        self.db.update_account(acc["id"], channel_id=ch.id)
        return ch, "nayi public channel bani"

    async def set_channel(self, acc: dict, ref: str) -> Channel:
        client = await self.client_for(acc)
        ref = ref.strip().lstrip("@")
        ent = await client.get_entity(int(ref) if re.fullmatch(r"-?\d+", ref) else ref)
        if not isinstance(ent, Channel) or not ent.broadcast or not ent.creator:
            raise ValueError("Ye is account ki apni (creator) broadcast channel nahi hai")
        ent = await self._make_public(client, ent)
        self.db.update_account(acc["id"], channel_id=ent.id)
        return ent

    # ---------- job control ----------
    def armed_epoch(self):
        v = self.db.get("armed_epoch", "")
        return float(v) if v else None

    def arm(self, epoch: float, forever: bool = False):
        self.disarm_task()
        self.db.set("armed_epoch", epoch)
        self.db.set("armed_forever", "1" if forever else "")
        self.stop = asyncio.Event()
        self.task = asyncio.create_task(self._run(epoch, forever))
        self.phase = "armed"

    def disarm_task(self):
        if self.task and not self.task.done():
            self.stop.set()
            self.task.cancel()
        self.task = None
        self.phase = "idle"
        self.db.set("armed_epoch", "")
        self.db.set("armed_forever", "")

    @property
    def busy(self):
        return self.task is not None and not self.task.done()

    async def _sleep_until(self, epoch: float, local: bool = False):
        clock = time.time if local else self.now
        while True:
            left = epoch - clock()
            if left <= 0:
                return
            if left > 0.05:
                await asyncio.sleep(min(left - 0.03, 1.0))
            else:
                await asyncio.sleep(0)

    async def _prepare(self) -> list[Stat]:
        stats = []
        accs = self.db.accounts(only_active=True)

        async def one(acc):
            try:
                client = await self.client_for(acc)
                ch, how = await self.ensure_channel(acc, client)
                stats.append(Stat(acc=acc, client=client, channel=ch))
            except Exception as e:
                await self.notify(f"⚠️ Account <b>{html.escape(acc.get('phone') or '?')}</b> ready nahi hua: {html.escape(str(e))}")

        await asyncio.gather(*(one(a) for a in accs))
        if stats:
            try:  # Telegram server time se clock sync
                st = stats[0].client._sender.state
                self.offset = float(st.time_offset)
            except Exception:
                self.offset = 0.0
        return stats

    async def _run(self, epoch: float, forever: bool = False):
        try:
            lead = self.db.int("lead_s")
            self.phase = "armed"
            await self._sleep_until(epoch - lead, local=True)
            self.phase = "preparing"
            stats = await self._prepare()
            if not stats:
                await self.notify("❌ Koi bhi account ready nahi, job cancel.")
                return
            await self.notify(f"🟢 {len(stats)} account ready. Target <code>@{self.db.get('target')}</code> pe tries "
                              f"<b>{fmt_ts(epoch)} IST</b> se shuru honge (clock offset {self.offset * 1000:+.0f}ms).")
            await self._sleep_until(epoch)
            self.phase = "running"
            await self._attack(stats, epoch, forever)
        except asyncio.CancelledError:
            await self.notify("⏹ Job stop kar diya.")
            raise
        except Exception as e:
            log.exception("job crash")
            await self.notify(f"💥 Job error: {html.escape(repr(e))}")
        finally:
            self.phase = "idle"
            self.db.set("armed_epoch", "")
            self.db.set("armed_forever", "")

    async def _attack(self, stats: list[Stat], epoch: float, forever: bool = False):
        target = self.db.get("target")
        gap = max(self.db.int("gap_ms"), 1) / 1000
        end = float("inf") if forever else epoch + self.db.int("window_s")
        jit = min(max(self.db.int("jitter_pct"), 0), 90) / 100
        max_att = self.db.int("max_att")
        self.winner = None
        self.stop = asyncio.Event()
        started = self.now()
        await self._dispatch(stats, epoch, gap, end, max_att, target, jit)
        finished = self.now()
        report = self._report(stats, target, epoch, started, finished)
        self.db.add_report(time.time(), report)
        kb = None
        if self.winner:
            kb = [[("👤 Profile username pe lagao", f"mv:{self.winner.acc['id']}")]]
        await self.notify(report, kb)

    async def _dispatch(self, stats, first_at, gap, end, max_att, target, jit):
        """Sab accounts ke liye ek hi gap, baari-baari: acc1, gap, acc2, gap, acc3 ... phir wapas acc1.
        Jis account par FloodWait hai ya jo dead hai, uski baari chhod di jati hai."""
        n = len(stats)
        idx = 0
        nxt = first_at
        tasks = []

        def usable(st, t):
            if st.dead or (max_att and st.attempts >= max_att):
                return False
            return st.paused_until <= t and st.inflight < 4

        while not self.stop.is_set():
            t = self.now()
            if t >= end:
                break
            # koi account bacha hi nahi (sab dead / max attempts)?
            if all(st.dead or (max_att and st.attempts >= max_att) for st in stats):
                break
            if t < nxt:
                await self._sleep_until(min(nxt, end))
                continue
            pick = None
            for k in range(n):
                st = stats[(idx + k) % n]
                if usable(st, t):
                    pick = (idx + k) % n
                    break
            if pick is None:  # sab FloodWait me: sabse jaldi wala khulne tak ruko
                wake = min((st.paused_until for st in stats if not st.dead and not (max_att and st.attempts >= max_att)), default=t + 1)
                if wake >= end:
                    break
                await asyncio.sleep(min(max(wake - t, 0.05), 1))
                nxt = max(nxt, self.now())
                continue
            st = stats[pick]
            st.attempts += 1
            tasks.append(asyncio.create_task(self._attempt(st, target)))
            idx = (pick + 1) % n
            nxt += gap * random.uniform(1 - jit, 1 + jit)  # thoda random: har try ek jaise fasle par nahi
            if nxt < t - gap:  # peeche reh gaye to burst nahi
                nxt = t + gap
            tasks = [x for x in tasks if not x.done()]
            await asyncio.sleep(0)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _attempt(self, st: Stat, target: str):
        st.inflight += 1
        ts = self.now()
        if st.first is None:
            st.first = ts
        n = st.attempts
        try:
            await st.client(ChUser(st.channel, target))
            self._win(st, n)
        except errors.UsernameNotModifiedError:
            self._win(st, n)
        except errors.FloodWaitError as e:
            st.errors["FloodWait"] += 1
            st.floods.append((ts, e.seconds))
            st.paused_until = self.now() + e.seconds
            await self.notify(f"⏳ <b>FloodWait</b>: <code>{html.escape(st.label)}</code> par "
                              f"<b>{e.seconds}s</b> ka flood wait laga ({fmt_ts(ts)}). Itni der ye account pause.")
        except errors.RPCError as e:
            name = type(e).__name__
            st.errors[name] += 1
            if any(k in (e.message or "") for k in DEAD_ERRORS):
                st.dead = True
                await self.notify(f"☠️ Account <code>{html.escape(st.label)}</code> dead/logout: {html.escape(e.message)}")
        except Exception as e:
            st.errors[type(e).__name__] += 1
        finally:
            st.inflight -= 1

    def _win(self, st: Stat, n: int):
        if self.winner is None:
            self.winner = st
            st.win = self.now()
            st.win_attempt = n
            self.stop.set()

    def _report(self, stats, target, epoch, started, finished) -> str:
        ok = self.winner is not None
        total = sum(s.attempts for s in stats)
        lines = [
            f"{'✅ <b>USERNAME MIL GAYA</b>' if ok else '❌ <b>Username nahi mila</b>'} — <code>@{html.escape(target)}</code>",
            "",
            f"🕒 Schedule: {fmt_ts(epoch)} IST",
            f"▶️ Shuru: {fmt_ts(started)} | ⏹ Khatam: {fmt_ts(finished)}",
            f"⏱ Duration: {finished - epoch:.2f}s | Gap: {self.db.int('gap_ms') / 1000:g}s",
            f"🔁 Total attempts: <b>{total}</b> ({len(stats)} account)",
        ]
        if ok:
            w = self.winner
            lines.append(f"🏆 Winner: <code>{html.escape(w.label)}</code> — {fmt_ts(w.win)} IST, "
                         f"schedule ke <b>{w.win - epoch:.3f}s</b> baad, <b>{w.win_attempt}</b>th attempt par")
        lines.append("")
        for s in stats:
            errs = ", ".join(f"{k}×{v}" for k, v in s.errors.most_common()) or "-"
            fl = f" | FloodWait: {len(s.floods)}x ({sum(x[1] for x in s.floods)}s total)" if s.floods else ""
            first = f" | pehla try {fmt_ts(s.first)}" if s.first else ""
            lines.append(f"• <code>{html.escape(s.label)}</code>: {s.attempts} attempts{first}{fl}\n   errors: {html.escape(errs)}")
        return "\n".join(lines)

    # ---------- winner: channel se profile pe ----------
    async def move_to_profile(self, aid: int) -> str:
        acc = self.db.account(aid)
        target = self.db.get("target")
        client = await self.client_for(acc)
        ch, _ = await self.ensure_channel(acc, client)
        await client(ChUser(ch, ""))  # channel se username hatao
        last = None
        for _ in range(8):
            try:
                await client(AccUser(target))
                return f"✅ <code>@{target}</code> ab account ke profile par lag gaya."
            except errors.FloodWaitError as e:
                return f"⏳ FloodWait {e.seconds}s. Username abhi channel se hata hua hai, baad me dobara try karo."
            except errors.RPCError as e:
                last = type(e).__name__
                await asyncio.sleep(0.3)
        # fail: channel par wapas lagao
        try:
            await client(ChUser(ch, target))
        except Exception:
            pass
        return f"❌ Profile par nahi laga ({last}). Username channel par wapas laga diya."
