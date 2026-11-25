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

from telethon import TelegramClient, errors, events
from telethon.password import compute_check
from telethon.sessions import StringSession
from telethon.tl.functions.account import GetPasswordRequest, GetPasswordSettingsRequest
from telethon.tl.functions.account import UpdateUsernameRequest as AccUser
from telethon.tl.functions.auth import ResetAuthorizationsRequest
from telethon.tl.functions.channels import CreateChannelRequest, GetAdminedPublicChannelsRequest
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
    last_try: float | None = None
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
        self.listeners: dict[int, TelegramClient] = {}  # OTP forward ke liye, alag se (receive_updates=True)
        self.task: asyncio.Task | None = None
        self.stop = asyncio.Event()
        self.offset = 0.0
        self.winner: Stat | None = None
        self.phase = "idle"  # idle | armed | preparing | running
        # live /stats ke liye
        self.live: list[Stat] = []
        self.run_target = ""
        self.run_started = 0.0
        self.next_at = 0.0
        self.next_idx = 0
        self._ch_job = False  # one-time "make P-channels" job chal raha hai ya nahi

    def now(self) -> float:
        return time.time() + self.offset

    # ---------- clients / channels ----------
    @staticmethod
    def make_client(session: str = "", listen: bool = False) -> TelegramClient:
        # listen=False (claim ke waqt): updates band, extra getDifference requests aur log shor nahi.
        # listen=True (OTP listener): updates chalu, taaki naye messages (login code) turant mil jayen.
        c = TelegramClient(StringSession(session), API_ID, API_HASH, request_retries=1,
                           receive_updates=listen)
        c.flood_sleep_threshold = 0  # FloodWait ko khud handle karenge, Telethon chup-chaap sleep na kare
        return c

    # ---------- OTP / login-code forwarding ----------
    # Har add kiye hue account ka ek "listener" client chalta rehta hai (job chale ya na chale).
    # Telegram apne official "Telegram" service account (id 777000) se login code bhejta hai -
    # wahi message yahan se turant admin ko forward ho jata hai.
    async def _on_service_msg(self, label: str, event):
        text = (event.raw_text or "").strip()
        if not text:
            return
        m = re.search(r"\b(\d{4,8})\b", text)
        extra = f"\n\n🔢 <b>Code:</b> <code>{m.group(1)}</code>" if m else ""
        await self.notify(f"🔑 <b>{html.escape(label)}</b> got a message from Telegram (could be a login/OTP code):\n\n"
                          f"{html.escape(text)}{extra}")

    async def start_otp_listener(self, acc: dict):
        aid = acc["id"]
        if aid in self.listeners:
            return
        label = acc.get("phone") or acc.get("name") or str(aid)
        try:
            c = self.make_client(dec(acc["session"]), listen=True)
            await c.connect()
            if not await c.is_user_authorized():
                await c.disconnect()
                log.warning("listener: %s logged out, OTP forward band", label)
                return
        except Exception as e:
            log.warning("listener connect fail for %s: %r", label, e)
            return

        async def handler(event):
            try:
                await self._on_service_msg(label, event)
            except Exception as e:
                log.warning("otp forward fail (%s): %r", label, e)

        c.add_event_handler(handler, events.NewMessage(from_users=777000))
        self.listeners[aid] = c
        log.info("OTP listener started for %s", label)

    async def stop_otp_listener(self, aid: int):
        c = self.listeners.pop(aid, None)
        if c:
            try:
                await c.disconnect()
            except Exception:
                pass

    async def start_all_listeners(self):
        """Startup par (aur redeploy ke baad) sab accounts ke liye OTP listener chalu karo."""
        for acc in self.db.accounts():
            await self.start_otp_listener(acc)

    async def client_for(self, acc: dict) -> TelegramClient:
        c = self.clients.get(acc["id"])
        if c is None:
            c = self.make_client(dec(acc["session"]))
            self.clients[acc["id"]] = c
        if not c.is_connected():
            await c.connect()
        if not await c.is_user_authorized():
            raise RuntimeError("session is logged out, add the account again")
        return c

    async def change_2fa(self, acc: dict, current: str | None, new: str):
        """Set/replace the cloud password. current=None if the account has no 2FA yet."""
        client = await self.client_for(acc)
        await client.edit_2fa(current_password=current or None, new_password=new)

    async def check_2fa(self, acc: dict, current: str) -> bool:
        """True if `current` is this account's correct 2FA password. No side effects
        (uses account.getPasswordSettings, which only verifies, never changes anything)."""
        client = await self.client_for(acc)
        pwd = await client(GetPasswordRequest())
        if not pwd.has_password:
            return False
        ic = compute_check(pwd, current)
        try:
            await client(GetPasswordSettingsRequest(password=ic))
            return True
        except errors.PasswordHashInvalidError:
            return False

    async def terminate_other_sessions(self, acc: dict):
        """Logs out every OTHER device/session of this account, keeping only the one this
        bot is currently using (same as Telegram's own "Terminate All Other Sessions")."""
        client = await self.client_for(acc)
        await client(ResetAuthorizationsRequest())

    # ---------- one-time: har account me prefix-wali public channel banao (jisme nahi hai) ----------
    NEUTRAL_TITLES = ["My Channel", "Daily Notes", "Updates", "Saved", "My Space",
                      "Notes", "Favorites", "Bookmarks", "My Updates", "Diary", "Personal"]

    async def _create_prefix_channel(self, client, acc, prefix, title) -> str:
        """Ek nayi public broadcast channel banao, uspe prefix se shuru hone wala random username lagao."""
        created = await client(CreateChannelRequest(title=title, about="", broadcast=True))
        ch = created.chats[0]
        last = "unknown"
        for _ in range(5):
            uname = prefix + secrets.token_hex(4)  # p + 8 hex = 9 chars, valid username
            try:
                await client(ChUser(ch, uname))
                self.db.update_account(acc["id"], channel_id=ch.id)
                return uname
            except errors.UsernameOccupiedError:
                last = "username occupied"
            except errors.UsernameInvalidError:
                last = "username invalid"
        raise RuntimeError(f"could not set a public username ({last})")

    async def make_missing_prefix_channels(self):
        """ONE-TIME: har account me dekho ki prefix-wali ('P') public channel hai ya nahi.
        Jisme nahi hai usme ek normal-naam wali public channel bana do; jisme already hai usse chhod do.
        Accounts ke beech gap+jitter rakhta hai (same-IP burst se bachne ke liye). Background me chalta hai,
        progress self.notify se bhejta hai."""
        if self._ch_job:
            await self.notify("⚠️ Channel-setup already chal raha hai.")
            return
        self._ch_job = True
        try:
            prefix = (self.db.get("channel_prefix") or "p").strip().lower().lstrip("@") or "p"
            accs = self.db.accounts()
            made, had, failed = [], [], []
            await self.notify(f"🏗 <b>'{prefix.upper()}' channel setup</b> shuru — {len(accs)} account check kar raha hu. "
                              "Har account ke beech thoda gap rakhunga (safe rehne ke liye), to time lagega.")
            first = True
            for a in accs:
                label = a.get("phone") or a.get("name") or str(a["id"])
                if not first:
                    await asyncio.sleep(random.uniform(20, 45))  # same-IP spam signal kam karne ke liye
                first = False
                try:
                    client = await self.client_for(a)
                    res = await client(GetAdminedPublicChannelsRequest())
                    pub = [c for c in res.chats if isinstance(c, Channel) and c.username]
                except Exception as e:
                    failed.append(f"{label}: {e}")
                    await self.notify(f"❌ <code>{html.escape(label)}</code>: {html.escape(str(e))}")
                    continue
                exist = next((c for c in pub if c.username.lower().startswith(prefix)), None)
                if exist:
                    self.db.update_account(a["id"], channel_id=exist.id)
                    had.append(label)
                    await self.notify(f"✅ <code>{html.escape(label)}</code>: pehle se hai "
                                      f"(@{html.escape(exist.username)}), chhod diya.")
                    continue
                try:
                    title = random.choice(self.NEUTRAL_TITLES)
                    uname = await self._create_prefix_channel(client, a, prefix, title)
                    made.append(label)
                    await self.notify(f"🆕 <code>{html.escape(label)}</code>: channel bana — "
                                      f"<b>{html.escape(title)}</b> (@{html.escape(uname)})")
                except errors.FloodWaitError as e:
                    failed.append(f"{label}: FloodWait {e.seconds}s")
                    await self.notify(f"⏳ <code>{html.escape(label)}</code>: FloodWait {e.seconds}s — skip. "
                                      "Ye account abhi naya/limited hai, baad me dobara chala lena.")
                except Exception as e:
                    failed.append(f"{label}: {type(e).__name__}: {e}")
                    await self.notify(f"❌ <code>{html.escape(label)}</code>: {html.escape(str(e))}")
            with_ch = len(made) + len(had)
            summary = (f"🏁 <b>Done.</b>\n"
                       f"📣 Ab total <b>{with_ch}/{len(accs)}</b> account pe '{prefix.upper()}' username wali channel hai.\n\n"
                       f"🆕 Naya bana: {len(made)}\n"
                       f"✅ Pehle se tha: {len(had)}\n❌ Fail: {len(failed)}")
            if failed:
                summary += "\n\n<b>Fail hue (inpe abhi nahi bani):</b>\n" + "\n".join(f"• {html.escape(x)}" for x in failed)
            await self.notify(summary[:4000])
        finally:
            self._ch_job = False

    async def account_info(self, acc: dict) -> dict:
        """Live info seedhe Telegram se: id, phone, username, 2FA (cloud password) status."""
        client = await self.client_for(acc)
        me = await client.get_me()
        try:
            pwd = await client(GetPasswordRequest())
            two_fa = bool(pwd.has_password)
        except Exception as e:
            log.warning("GetPasswordRequest failed: %r", e)
            two_fa = None  # could not read
        return {
            "id": me.id,
            "phone": me.phone,
            "username": me.username,
            "first_name": me.first_name,
            "last_name": me.last_name,
            "two_fa": two_fa,
        }

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
        """Claim ke liye channel chunna.
        channel_prefix set ho (default 'p'): account ki apni public channel jiska username us letter se shuru ho.
        Nayi channel BANAI NAHI JATI (channel banana + username lagana naye accounts par FloodWait deta hai)."""
        prefix = (self.db.get("channel_prefix") or "").strip().lower().lstrip("@")
        if prefix:
            pub = []
            try:  # account ki owned public channels seedhi list
                res = await client(GetAdminedPublicChannelsRequest())
                pub = [c for c in res.chats if isinstance(c, Channel) and c.username]
            except Exception as e:
                log.warning("getAdminedPublicChannels fail: %r", e)
            match = [c for c in pub if c.username.lower().startswith(prefix)]
            if match:
                saved = acc.get("channel_id")
                ch = next((c for c in match if c.id == saved), match[0])
                self.db.update_account(acc["id"], channel_id=ch.id)
                return ch, f"found channel starting with '{prefix.upper()}'"
            if acc.get("channel_id"):  # reuse a channel already claimed before (its username is now the target)
                dialogs = [d.entity async for d in client.iter_dialogs(limit=300) if isinstance(d.entity, Channel)]
                for e in dialogs:
                    if e.id == acc["channel_id"] and e.broadcast and e.creator:
                        return await self._make_public(client, e), "saved channel"
            raise RuntimeError(f"No public channel starting with '{prefix.upper()}' was found on this account. "
                               f"Create a public channel in the Telegram app with a username starting with "
                               f"'{prefix.upper()}', then add the account again (or reactivate it from /menu).")
        dialogs = [d.entity async for d in client.iter_dialogs(limit=300) if isinstance(d.entity, Channel)]
        owned = [e for e in dialogs if e.broadcast and e.creator]
        if acc.get("channel_id"):
            for e in owned:
                if e.id == acc["channel_id"]:
                    return await self._make_public(client, e), "saved channel"
        for e in owned:
            if e.username:
                self.db.update_account(acc["id"], channel_id=e.id)
                return e, "found an existing public channel"
        res = await client(CreateChannelRequest(title="Notes", about="", broadcast=True))
        ch = await self._make_public(client, res.chats[0])
        self.db.update_account(acc["id"], channel_id=ch.id)
        return ch, "created a new public channel"

    async def set_channel(self, acc: dict, ref: str) -> Channel:
        client = await self.client_for(acc)
        ref = ref.strip().lstrip("@")
        ent = await client.get_entity(int(ref) if re.fullmatch(r"-?\d+", ref) else ref)
        if not isinstance(ent, Channel) or not ent.broadcast or not ent.creator:
            raise ValueError("This is not a broadcast channel owned (created) by this account")
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
                stat = Stat(acc=acc, client=client, channel=ch)
                try:  # restart se pehle ka FloodWait yaad rakho (server par wo chalta rehta hai)
                    stat.paused_until = float(self.db.get(f"flood_until_{acc['id']}") or 0) - self.offset
                except ValueError:
                    pass
                stats.append(stat)
            except Exception as e:
                await self.notify(f"⚠️ Account <b>{html.escape(acc.get('phone') or '?')}</b> not ready: {html.escape(str(e))}")

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
                await self.notify("❌ No account is ready, job cancelled.")
                return
            await self.notify(f"🟢 {len(stats)} account(s) ready. Tries for target <code>@{self.db.get('target')}</code> "
                              f"will start at <b>{fmt_ts(epoch)} IST</b> (clock offset {self.offset * 1000:+.0f}ms).")
            await self._sleep_until(epoch)
            self.phase = "running"
            await self._attack(stats, epoch, forever)
        except asyncio.CancelledError:
            await self.notify("⏹ Job stopped.")
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
        jit = min(max(self.db.int("jitter_pct"), 0), 50) / 100
        max_att = self.db.int("max_att")
        min_gap = max(self.db.int("acct_gap_s"), 0)
        self.winner = None
        self.stop = asyncio.Event()
        started = self.now()
        self.live, self.run_target, self.run_started = stats, target, time.time()
        await self._dispatch(stats, epoch, gap, end, max_att, target, jit, min_gap)
        finished = self.now()
        report = self._report(stats, target, epoch, started, finished)
        self.db.add_report(time.time(), report)
        kb = None
        if self.winner:
            kb = [[("👤 Profile username pe lagao", f"mv:{self.winner.acc['id']}")]]
        await self.notify(report, kb)

    async def _dispatch(self, stats, first_at, gap, end, max_att, target, jit, min_gap=0):
        """Sab accounts ke liye ek hi gap, baari-baari: acc1, gap, acc2, gap, acc3 ... phir wapas acc1.
        Jis account par FloodWait hai ya jo dead hai, uski baari chhod di jati hai."""
        n = len(stats)
        idx = 0
        nxt = first_at
        tasks = []

        def wait_for(st, t):
            """Is account ko try karne me kitne second baaki (FloodWait + compulsory per-account gap)."""
            w = st.paused_until - t
            if st.last_try:
                w = max(w, st.last_try + min_gap - time.time())
            return max(w, 0.0)

        def usable(st, t):
            if st.dead or (max_att and st.attempts >= max_att):
                return False
            return wait_for(st, t) <= 0 and st.inflight < 4

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
            if pick is None:  # sab FloodWait/per-account gap me: sabse jaldi wala khulne tak ruko
                waits = [wait_for(st, t) for st in stats if not st.dead and not (max_att and st.attempts >= max_att)]
                wake = min(waits, default=1.0)
                if t + wake >= end:
                    break
                await asyncio.sleep(min(max(wake, 0.05), 1))
                nxt = max(nxt, self.now())
                continue
            st = stats[pick]
            st.attempts += 1
            st.last_try = time.time()
            tasks.append(asyncio.create_task(self._attempt(st, target)))
            idx = (pick + 1) % n
            self.next_idx = idx
            nxt += gap * random.uniform(1 - jit, 1 + jit)  # thoda random: har try ek jaise fasle par nahi
            self.next_at = nxt
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
            self.db.set(f"flood_until_{st.acc['id']}", time.time() + e.seconds)
            rq = getattr(e, "request", None)
            rq = getattr(rq, "query", rq)  # receive_updates=False wraps the request inside InvokeWithoutUpdates
            req = type(rq).__name__ if rq is not None else "?"
            await self.notify(f"⏳ <b>FloodWait</b>: <code>{html.escape(st.label)}</code> got a "
                              f"<b>{e.seconds}s</b> flood wait ({fmt_ts(ts)}), request: <code>{req}</code>, "
                              f"on this account's try #{n} (after {sum(x.attempts for x in self.live)} total tries across all accounts). "
                              f"This account is paused for that long.")
        except errors.RPCError as e:
            name = type(e).__name__
            st.errors[name] += 1
            if any(k in (e.message or "") for k in DEAD_ERRORS):
                st.dead = True
                await self.notify(f"☠️ Account <code>{html.escape(st.label)}</code> dead/logged out: {html.escape(e.message)}")
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
            f"{'✅ <b>USERNAME CLAIMED</b>' if ok else '❌ <b>Username not claimed</b>'} — <code>@{html.escape(target)}</code>",
            "",
            f"🕒 Schedule: {fmt_ts(epoch)} IST",
            f"▶️ Started: {fmt_ts(started)} | ⏹ Finished: {fmt_ts(finished)}",
            f"⏱ Duration: {finished - epoch:.2f}s | Gap: {self.db.int('gap_ms') / 1000:g}s",
            f"🔁 Total attempts: <b>{total}</b> ({len(stats)} account(s))",
        ]
        if ok:
            w = self.winner
            lines.append(f"🏆 Winner: <code>{html.escape(w.label)}</code> — {fmt_ts(w.win)} IST, "
                         f"<b>{w.win - epoch:.3f}s</b> after schedule, on attempt <b>#{w.win_attempt}</b>")
        lines.append("")
        for s in stats:
            errs = ", ".join(f"{k}×{v}" for k, v in s.errors.most_common()) or "-"
            fl = f" | FloodWait: {len(s.floods)}x ({sum(x[1] for x in s.floods)}s total)" if s.floods else ""
            first = f" | first try {fmt_ts(s.first)}" if s.first else ""
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
                return f"✅ <code>@{target}</code> is now set on the account's profile."
            except errors.FloodWaitError as e:
                return f"⏳ FloodWait {e.seconds}s. Username has been removed from the channel for now, try again later."
            except errors.RPCError as e:
                last = type(e).__name__
                await asyncio.sleep(0.3)
        # fail: put the username back on the channel
        try:
            await client(ChUser(ch, target))
        except Exception:
            pass
        return f"❌ Could not set it on the profile ({last}). Username put back on the channel."
