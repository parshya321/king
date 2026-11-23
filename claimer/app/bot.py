import html
import re
import time

from aiogram import BaseMiddleware, F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message
from telethon import errors

from .config import API_HASH, API_ID, enc
from .sessions import extract_candidates
from .engine import Engine, fmt_ts, parse_sched, sched_epoch

router = Router()
db = None  # main.py set karega
engine: Engine | None = None
pending_login: dict[int, dict] = {}

USERNAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]{4,31}$")


class S(StatesGroup):
    phone = State()
    code = State()
    pwd = State()
    session_in = State()
    edit = State()
    chan = State()


# ---------- helpers ----------
def kb(rows) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text=t, callback_data=d) for t, d in row] for row in rows]
    )


MAIN_KB = kb([
    [("👤 Accounts", "acc:list"), ("⚙️ Settings", "set:menu")],
    [("⚡ Start", "job:now"), ("⏹ Stop", "job:stop")],
    [("📊 Stats", "m:stats"), ("📡 Status", "m:status")],
    [("📊 Last report", "rep:last")],
])
BACK = [("⬅️ Menu", "m:main")]


async def show(ev, text, markup=None):
    if isinstance(ev, CallbackQuery):
        try:
            await ev.message.edit_text(text, reply_markup=markup)
        except TelegramBadRequest:
            pass
        await ev.answer()
    else:
        await ev.answer(text, reply_markup=markup)


def owner_id():
    v = db.get("owner", "")
    return int(v) if v else None


class OwnerOnly(BaseMiddleware):
    async def __call__(self, handler, event, data):
        uid = event.from_user.id if event.from_user else None
        o = owner_id()
        if o is None:
            if isinstance(event, Message) and (event.text or "").startswith("/start"):
                return await handler(event, data)
            return
        if uid != o:
            return
        return await handler(event, data)


router.message.outer_middleware(OwnerOnly())
router.callback_query.outer_middleware(OwnerOnly())


async def notify(bot, text, rows=None):
    o = owner_id()
    if o is None:
        return
    if text.startswith("⏳") and db.get("notify") != "1":
        return
    markup = kb([[(t, d) for t, d in r] for r in rows]) if rows else None
    try:
        await bot.send_message(o, text, reply_markup=markup)
    except Exception:
        pass


# ---------- screens ----------
async def screen_main(ev):
    await show(ev, "🤖 <b>Username Claimer</b>\nSab kuch yahin se control hoga.", MAIN_KB)


def status_text() -> str:
    accs = db.accounts()
    ep = engine.armed_epoch()
    lines = ["📡 <b>Status</b>", f"Phase: <b>{engine.phase}</b>"]
    if ep and engine.busy:
        lines.append(f"Schedule: {fmt_ts(ep)} IST ({max(0, ep - time.time()):.0f}s baaki)")
    lines.append(f"Target: <code>@{html.escape(db.get('target') or '—')}</code>")
    lines.append(f"Accounts: {sum(1 for a in accs if a['active'])} active / {len(accs)} total")
    return "\n".join(lines)


def _ago(ts) -> str:
    if not ts:
        return "—"
    d = max(0, int(time.time() - ts))
    return f"{d}s pehle" if d < 60 else f"{d // 60}m {d % 60}s pehle"


def _dur(sec: float) -> str:
    sec = int(max(0, sec))
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    return (f"{h}h " if h else "") + (f"{m}m " if h or m else "") + f"{s}s"


def stats_text() -> str:
    live = engine.live
    running = engine.busy and engine.phase in ("running", "preparing")
    L = ["📊 <b>Stats</b>"]
    if not live:
        L.append("Abhi koi job nahi chala. <code>/set @username</code> se shuru karo.")
        L.append(f"Accounts: {sum(1 for a in db.accounts() if a['active'])} active / {len(db.accounts())} total")
        return "\n".join(L)
    total = sum(s.attempts for s in live)
    el = time.time() - engine.run_started if engine.run_started else 0
    state = {"running": "🟢 Chal raha hai", "preparing": "🟡 Taiyari me", "armed": "🟡 Armed"}.get(engine.phase, "⚪ Ruka hua")
    if engine.winner:
        state = "🏆 Username mil gaya!"
    L.append(f"{state}\n🎯 Username: <code>@{html.escape(engine.run_target or '—')}</code>")
    L.append(f"⏱ Chalte hue: <b>{_dur(el)}</b>")
    L.append(f"🔢 Kul tries: <b>{total}</b>" + (f"  (~{total / max(el / 60, 1/60):.1f}/min)" if el > 5 else ""))
    L.append(f"⚙️ Gap: {gap_s()}s (+/- {db.get('jitter_pct')}% random) | har account min {db.get('acct_gap_s')}s")
    if running and not engine.winner and engine.next_at:
        order = [live[(engine.next_idx + k) % len(live)] for k in range(len(live))]
        nxt_acc = next((x for x in order if not x.dead and x.paused_until <= engine.now()), None)
        if nxt_acc:
            L.append(f"➡️ Agla try: <code>{html.escape(nxt_acc.label)}</code> se {max(0, engine.next_at - time.time()):.0f}s me")
    L.append("")
    now = time.time()
    for s in live:
        if s.dead:
            st = "☠️ dead/logout"
        elif s.paused_until > engine.now():
            st = f"⏳ FloodWait ({int(s.paused_until - engine.now())}s baaki)"
        else:
            st = "✅ ready"
        if engine.winner is s:
            st = "🏆 jeeta"
        errs = ", ".join(f"{k}×{v}" for k, v in s.errors.most_common(3)) or "—"
        L.append(f"• <code>{html.escape(s.label)}</code> {st}\n"
                 f"   tries: <b>{s.attempts}</b> | last: {_ago(s.last_try)} | floods: {len(s.floods)}\n"
                 f"   errors: {html.escape(errs)}")
    return "\n".join(L)


def gap_s() -> str:
    return f"{db.int('gap_ms') / 1000:g}"


def settings_view(adv=False):
    g = db.get
    if not adv:  # simple screen: sirf Target, Time, Gap (seconds me)
        text = (
            "⚙️ <b>Settings</b>\n\n"
            f"🎯 Target: <code>@{html.escape(g('target') or '—')}</code>\n"
            f"⏱ Gap: <b>{gap_s()} second</b> (+/- {g('jitter_pct')}% random)\n"
            f"⏳ Har account kam se kam <b>{g('acct_gap_s')} s</b> baad hi dobara try karega\n"
            "Accounts baari-baari se chalte hain, har try ke beech itna gap.\n\n"
            "Chalane ke liye: <code>/set @username</code>   Rokne ke liye: /stop"
        )
        rows = [
            [("🎯 Target", "edit:target")],
            [("➖0.1s", "adj:gap_ms:-100"), ("⏱ Gap ✏️", "edit:gap_ms"), ("➕0.1s", "adj:gap_ms:100")],
            [("🔧 Advanced", "set:adv")],
            BACK,
        ]
        return text, kb(rows)
    text = (
        "🔧 <b>Advanced settings</b>\n\n"
        f"🎯 Target: <code>@{html.escape(g('target') or '—')}</code>\n"
        f"⏱ Gap: <b>{gap_s()} second</b> (do tries ke beech, accounts baari-baari)\n"
        f"⏳ Har account ka min gap: <b>{g('acct_gap_s')} s</b> (compulsory, isse pehle wo account dobara try nahi karega)\n"
        f"🎲 Random: <b>+/- {g('jitter_pct')}%</b> (gap me thoda upar-neeche, 0 = fixed)\n"
        f"🔢 Max attempts/account: <b>{g('max_att')}</b> (0 = unlimited)\n"
        f"🔔 FloodWait notify: <b>{'ON' if g('notify') == '1' else 'OFF'}</b>"
    )
    rows = [
        [("🎯 Target", "edit:target")],
        [("➖0.1s", "adj:gap_ms:-100"), ("⏱ Gap ✏️", "edit:gap_ms"), ("➕0.1s", "adj:gap_ms:100")],
        [("➖5", "adj:acct_gap_s:-5"), ("⏳ Account gap ✏️", "edit:acct_gap_s"), ("➕5", "adj:acct_gap_s:5")],
        [("➖5", "adj:jitter_pct:-5"), ("🎲 Random % ✏️", "edit:jitter_pct"), ("➕5", "adj:jitter_pct:5")],
        [("➖10", "adj:max_att:-10"), ("🔢 Max ✏️", "edit:max_att"), ("➕10", "adj:max_att:10")],
        [(f"🔔 Notify: {'ON' if g('notify') == '1' else 'OFF'}", "tog:notify")],
        [("⬅️ Simple settings", "set:menu")],
    ]
    return text, kb(rows)


async def screen_settings(ev, adv=False):
    t, m = settings_view(adv)
    await show(ev, t, m)


async def screen_accounts(ev):
    accs = db.accounts()
    rows = [[(f"{'✅' if a['active'] else '⏸'} {a['name'] or a['phone']}", f"acc:{a['id']}")] for a in accs]
    rows.append([("📞 Phone se add", "acc:add"), ("📄 Session se add", "acc:addsession")])
    rows.append(BACK)
    await show(ev, f"👤 <b>Accounts</b> ({len(accs)})", kb(rows))


async def screen_account(ev, aid):
    a = db.account(aid)
    if not a:
        return await screen_accounts(ev)
    text = (f"👤 <b>{html.escape(a['name'] or '')}</b>\n📞 {html.escape(a['phone'] or '')}\n"
            f"Status: {'active' if a['active'] else 'paused'}\n"
            f"Channel ID: <code>{a['channel_id'] or 'abhi nahi (job se pehle auto ban/mil jayegi)'}</code>")
    rows = [
        [("⏸ Pause" if a["active"] else "▶️ Activate", f"acc:tog:{aid}")],
        [("📣 Channel auto (dhoondo/banao)", f"acc:auto:{aid}")],
        [("🆔 Channel ID/@username do", f"acc:ch:{aid}")],
        [("🗑 Remove", f"acc:del:{aid}")],
        [("⬅️ Accounts", "acc:list")],
    ]
    await show(ev, text, kb(rows))


async def screen_status(ev):
    await show(ev, status_text(), kb([[("🔄 Refresh", "m:status")], BACK]))


# ---------- commands ----------
@router.message(CommandStart())
async def cmd_start(m: Message, state: FSMContext):
    await state.clear()
    if owner_id() is None:
        db.set("owner", m.from_user.id)
        await m.answer("👑 Tum owner set ho gaye. Ab sirf tum ye bot control kar sakte ho.")
    await screen_main(m)


@router.message(Command("menu"))
async def cmd_menu(m: Message, state: FSMContext):
    await state.clear()
    await screen_main(m)


@router.message(Command("accounts"))
async def cmd_accounts(m: Message):
    await screen_accounts(m)


@router.message(Command("settings"))
async def cmd_settings(m: Message):
    await screen_settings(m)


@router.message(Command("status"))
async def cmd_status(m: Message):
    await screen_status(m)


@router.message(Command("stats"))
async def cmd_stats(m: Message):
    await m.answer(stats_text(), reply_markup=kb([[("🔄 Refresh", "m:stats")], BACK]))


@router.message(Command("report"))
async def cmd_report(m: Message):
    await m.answer(db.last_report() or "Abhi koi report nahi.", reply_markup=kb([BACK]))


@router.message(Command("stop"))
async def cmd_stop(m: Message):
    await do_stop(m)


@router.message(Command("set"))
async def cmd_set(m: Message):
    """/set @username : target set karke turant try karna shuru (/stop tak ya mil jane tak)"""
    parts = (m.text or "").split(maxsplit=1)
    name = parts[1].strip().lstrip("@") if len(parts) > 1 else ""
    if not USERNAME_RE.match(name):
        return await m.answer("Aise bhejo: <code>/set @username</code>\n(letter se shuru, 5-32 chars: a-z, 0-9, _)")
    if engine.busy:
        return await m.answer("⚠️ Job pehle se chal raha hai. Pehle /stop karo, phir /set.")
    db.set("target", name)
    await do_start(m)


# ---------- callbacks ----------
@router.callback_query(F.data == "m:main")
async def cb_main(c: CallbackQuery, state: FSMContext):
    await state.clear()
    await screen_main(c)


@router.callback_query(F.data == "m:stats")
async def cb_stats(c: CallbackQuery):
    await show(c, stats_text(), kb([[("🔄 Refresh", "m:stats")], BACK]))


@router.callback_query(F.data == "m:status")
async def cb_status(c: CallbackQuery):
    await screen_status(c)


@router.callback_query(F.data == "set:menu")
async def cb_settings(c: CallbackQuery, state: FSMContext):
    await state.clear()
    await screen_settings(c)


@router.callback_query(F.data == "set:adv")
async def cb_settings_adv(c: CallbackQuery, state: FSMContext):
    await state.clear()
    await screen_settings(c, True)


@router.callback_query(F.data.startswith("adj:"))
async def cb_adj(c: CallbackQuery):
    _, key, delta = c.data.split(":")[:3]
    floor = {"gap_ms": 1, "max_att": 0, "jitter_pct": 0, "acct_gap_s": 0}[key]
    val = max(floor, db.int(key) + int(delta))
    db.set(key, min(val, 50) if key == "jitter_pct" else val)
    await screen_settings(c, key != "gap_ms")


@router.callback_query(F.data == "tog:notify")
async def cb_tog(c: CallbackQuery):
    db.set("notify", "0" if db.get("notify") == "1" else "1")
    await screen_settings(c)


PROMPTS = {
    "target": "🎯 Target username bhejo (bina @, 5-32 chars):",
    "sched": "🕒 Time (IST) bhejo.\nFormat: <code>HH:MM:SS</code> ya <code>HH:MM:SS.mmm</code>\n"
             "Dusre din ke liye: <code>DD-MM-YYYY HH:MM:SS</code>",
    "gap_ms": "⏱ Gap <b>seconds</b> me bhejo (jaise <code>2</code> ya <code>0.5</code>):",
    "max_att": "🔢 Max attempts per account bhejo (0 = unlimited):",
    "acct_gap_s": "⏳ Har account ke 2 tries ke beech kam se kam kitne <b>second</b> (jaise 10):",
    "jitter_pct": "🎲 Random % bhejo (0-50). Jaise 20 = 10s gap me 8-12s:",
}


@router.callback_query(F.data.startswith("edit:"))
async def cb_edit(c: CallbackQuery, state: FSMContext):
    key = c.data.split(":")[1]
    await state.set_state(S.edit)
    await state.update_data(key=key)
    await show(c, PROMPTS[key], kb([[("❌ Cancel", "set:menu")]]))


@router.message(S.edit)
async def on_edit(m: Message, state: FSMContext):
    key = (await state.get_data())["key"]
    v = (m.text or "").strip()
    if key == "target":
        v = v.lstrip("@")
        if not USERNAME_RE.match(v):
            return await m.answer("❌ Galat username. Letter se shuru, 5-32 chars (a-z, 0-9, _). Dobara bhejo:")
    elif key == "sched":
        if not parse_sched(v):
            return await m.answer("❌ Format galat. Jaise <code>14:30:00</code>. Dobara bhejo:")
    elif key == "gap_ms":  # user seconds bhejta hai (decimal ok), andar milliseconds me save
        try:
            sec = float(v.replace(",", ".").lower().rstrip("s").strip())
        except ValueError:
            return await m.answer("❌ Seconds me number bhejo, jaise <code>2</code> ya <code>0.5</code>:")
        if not (0.001 <= sec <= 3600):
            return await m.answer("❌ 0.001 se 3600 second ke beech bhejo:")
        v = str(int(round(sec * 1000)))
    else:
        if not v.isdigit() or (key == "jitter_pct" and int(v) > 50):
            return await m.answer("❌ Sahi number bhejo:")
    db.set(key, v)
    await state.clear()
    await screen_settings(m, key in ("max_att", "jitter_pct", "acct_gap_s"))


# ----- accounts -----
@router.callback_query(F.data == "acc:list")
async def cb_acc_list(c: CallbackQuery, state: FSMContext):
    await state.clear()
    await screen_accounts(c)


@router.callback_query(F.data.regexp(r"^acc:\d+$"))
async def cb_acc(c: CallbackQuery):
    await screen_account(c, int(c.data.split(":")[1]))


@router.callback_query(F.data.startswith("acc:tog:"))
async def cb_acc_tog(c: CallbackQuery):
    aid = int(c.data.split(":")[2])
    a = db.account(aid)
    db.update_account(aid, active=0 if a["active"] else 1)
    await screen_account(c, aid)
    # OTP forward active/paused dono accounts ke liye chalu rehta hai (login kabhi bhi lagana pad sakta hai)


@router.callback_query(F.data.startswith("acc:del:"))
async def cb_acc_del(c: CallbackQuery):
    parts = c.data.split(":")
    aid = int(parts[2])
    if len(parts) == 3:
        return await show(c, "Pakka remove karna hai? Session bhi delete ho jayega.",
                          kb([[("✅ Haan, delete", f"acc:del:{aid}:y"), ("❌ Nahi", f"acc:{aid}")]]))
    await engine.drop_client(aid)
    await engine.stop_otp_listener(aid)
    db.delete_account(aid)
    await screen_accounts(c)


@router.callback_query(F.data.startswith("acc:auto:"))
async def cb_acc_auto(c: CallbackQuery):
    aid = int(c.data.split(":")[2])
    a = db.account(aid)
    await c.answer("Check kar raha hu...")
    try:
        client = await engine.client_for(a)
        ch, how = await engine.ensure_channel(a, client)
        await c.message.answer(f"📣 {how}: <b>{html.escape(ch.title)}</b> (<code>@{ch.username}</code>)")
    except Exception as e:
        await c.message.answer(f"❌ {html.escape(str(e))}")


@router.callback_query(F.data.startswith("acc:ch:"))
async def cb_acc_ch(c: CallbackQuery, state: FSMContext):
    aid = int(c.data.split(":")[2])
    await state.set_state(S.chan)
    await state.update_data(aid=aid)
    await show(c, "🆔 Channel ka ID ya @username bhejo (account ki apni channel honi chahiye):",
               kb([[("❌ Cancel", f"acc:{aid}")]]))


@router.message(S.chan)
async def on_chan(m: Message, state: FSMContext):
    aid = (await state.get_data())["aid"]
    try:
        ch = await engine.set_channel(db.account(aid), m.text or "")
        await state.clear()
        await m.answer(f"✅ Channel set: <b>{html.escape(ch.title)}</b> (<code>@{ch.username}</code>)")
        await screen_account(m, aid)
    except Exception as e:
        await m.answer(f"❌ {html.escape(str(e))}\nDobara bhejo ya /menu:")


# ----- add account (login) -----
@router.callback_query(F.data == "acc:add")
async def cb_acc_add(c: CallbackQuery, state: FSMContext):
    await state.set_state(S.phone)
    await show(c, "📞 Account ka phone number bhejo country code ke saath (jaise <code>+919876543210</code>):",
               kb([[("❌ Cancel", "acc:list")]]))


@router.message(S.phone)
async def on_phone(m: Message, state: FSMContext):
    phone = re.sub(r"[^\d+]", "", m.text or "")
    client = engine.make_client()
    try:
        await client.connect()
        sent = await client.send_code_request(phone)
    except Exception as e:
        await client.disconnect()
        return await m.answer(f"❌ {html.escape(str(e))}\nDobara number bhejo ya /menu:")
    pending_login[m.from_user.id] = {"client": client, "phone": phone, "hash": sent.phone_code_hash}
    await state.set_state(S.code)
    await m.answer("📩 Telegram ne code bheja hai. Code yahan bhejo <b>dash ke saath</b>, jaise <code>1-2-3-4-5</code> "
                   "(seedha bhejoge to Telegram code expire kar deta hai).")


async def finish_login(m: Message, state: FSMContext, client, phone):
    me = await client.get_me()
    name = " ".join(x for x in [me.first_name, me.last_name] if x) or (me.username or phone)
    aid = db.upsert_account(me.id, phone, name, enc(client.session.save()))
    engine.adopt_client(aid, client)
    pending_login.pop(m.from_user.id, None)
    await state.clear()
    msg = await m.answer(f"✅ <b>{html.escape(name)}</b> add ho gaya. Channel dekh raha hu...")
    try:
        ch, how = await engine.ensure_channel(db.account(aid), client)
        await msg.edit_text(f"✅ <b>{html.escape(name)}</b> add ho gaya.\n📣 {how}: "
                            f"<b>{html.escape(ch.title)}</b> (<code>@{ch.username}</code>)")
    except Exception as e:
        await msg.edit_text(f"✅ Account add hua, par channel setup fail: {html.escape(str(e))}")
    await engine.start_otp_listener(db.account(aid))
    await screen_accounts(m)


# ----- add account (session string / .session file / zip) -----
@router.callback_query(F.data == "acc:addsession")
async def cb_acc_addsession(c: CallbackQuery, state: FSMContext):
    await state.set_state(S.session_in)
    await show(c, "📄 Session string paste karo (ek ya kai lines me ek saath bhi), ya "
                  "<code>.session</code> / <code>.zip</code> / <code>.txt</code> file bhejo "
                  "(zip me kai sessions ek saath bhi chalega):",
               kb([[("❌ Cancel", "acc:list")]]))


@router.message(S.session_in)
async def on_session_in(m: Message, state: FSMContext):
    if m.document:
        name = m.document.file_name or "file"
        if m.document.file_size and m.document.file_size > 20 * 1024 * 1024:
            return await m.answer("❌ File 20MB se badi hai. Chhota bhejo ya /menu:")
        try:
            f = await m.bot.get_file(m.document.file_id)
            buf = await m.bot.download_file(f.file_path)
            data = buf.read() if hasattr(buf, "read") else bytes(buf)
        except Exception as e:
            return await m.answer(f"❌ File download nahi hui: {html.escape(str(e))}\nDobara bhejo ya /menu:")
    else:
        name = "pasted.txt"
        data = (m.text or "").encode("utf-8", "ignore")
    try:
        await m.delete()  # session string chat me na rahe
    except Exception:
        pass
    cands = extract_candidates(name, data)
    if not cands:
        return await m.answer("❌ Isme koi valid session string/file nahi mila. Dobara bhejo ya /menu:")
    status = await m.answer(f"🔍 {len(cands)} session mile, check kar raha hu...")
    ok, fail = [], []
    for label, sess in cands:
        client = engine.make_client(sess)
        try:
            await client.connect()
            if not await client.is_user_authorized():
                await client.disconnect()
                fail.append(f"{label}: session expired/logged out")
                continue
            me = await client.get_me()
            name2 = " ".join(x for x in [me.first_name, me.last_name] if x) or (me.username or label)
            aid = db.upsert_account(me.id, me.phone or "", name2, enc(client.session.save()))
        except Exception as e:
            try:
                await client.disconnect()
            except Exception:
                pass
            fail.append(f"{label}: {html.escape(str(e))}")
            continue
        engine.adopt_client(aid, client)
        try:
            ch, how = await engine.ensure_channel(db.account(aid), client)
            ok.append(f"{html.escape(name2)}: {how}")
        except Exception as e:
            ok.append(f"{html.escape(name2)}: add hua, channel setup fail ({html.escape(str(e))})")
        await engine.start_otp_listener(db.account(aid))
    await state.clear()
    parts = []
    if ok:
        parts.append(f"✅ <b>{len(ok)} account add hue:</b>\n" + "\n".join(f"• {x}" for x in ok))
    if fail:
        parts.append(f"❌ <b>{len(fail)} fail:</b>\n" + "\n".join(f"• {x}" for x in fail))
    await status.edit_text(("\n\n".join(parts) or "❌ Kuch nahi hua.")[:4000])
    await screen_accounts(m)


@router.message(S.code)
async def on_code(m: Message, state: FSMContext):
    p = pending_login.get(m.from_user.id)
    if not p:
        await state.clear()
        return await m.answer("Session expire, /menu se dobara shuru karo.")
    code = re.sub(r"\D", "", m.text or "")
    try:
        await m.delete()
    except Exception:
        pass
    try:
        await p["client"].sign_in(p["phone"], code, phone_code_hash=p["hash"])
    except errors.SessionPasswordNeededError:
        await state.set_state(S.pwd)
        return await m.answer("🔐 2FA password bhejo (message turant delete ho jayega):")
    except (errors.PhoneCodeInvalidError, errors.PhoneCodeExpiredError) as e:
        return await m.answer(f"❌ {type(e).__name__}. Sahi code dash ke saath bhejo ya /menu:")
    except Exception as e:
        return await m.answer(f"❌ {html.escape(str(e))}")
    await finish_login(m, state, p["client"], p["phone"])


@router.message(S.pwd)
async def on_pwd(m: Message, state: FSMContext):
    p = pending_login.get(m.from_user.id)
    pw = m.text or ""
    try:
        await m.delete()
    except Exception:
        pass
    if not p:
        await state.clear()
        return await m.answer("Session expire, /menu se dobara shuru karo.")
    try:
        await p["client"].sign_in(password=pw)
    except Exception as e:
        return await m.answer(f"❌ {html.escape(str(e))}\nDobara password bhejo ya /menu:")
    await finish_login(m, state, p["client"], p["phone"])


# ----- job -----
async def do_start(ev):
    if not db.get("target"):
        return await show(ev, "❌ Pehle Settings me Target username set karo.", kb([BACK]))
    if not db.accounts(only_active=True):
        return await show(ev, "❌ Koi active account nahi. Pehle account add karo.", kb([BACK]))
    if engine.busy:
        return await show(ev, "⚠️ Job pehle se chal raha hai. Pehle Stop karo.", kb([BACK]))
    engine.arm(time.time(), forever=True)
    await show(ev, f"🟢 <b>Chalu</b>\nTarget: <code>@{db.get('target')}</code>\n"
                   f"Gap: {gap_s()}s (+/- {db.get('jitter_pct')}% random)\n"
                   "Username milne ya /stop tak try chalta rahega.",
               kb([[("⏹ Stop", "job:stop")], BACK]))


async def do_stop(ev):
    if not engine.busy:
        return await show(ev, "Koi job nahi chal raha.", kb([BACK]))
    engine.disarm_task()
    await show(ev, "⏹ Stop ho gaya.", kb([BACK]))


@router.callback_query(F.data == "job:now")
async def cb_now(c: CallbackQuery):
    await do_start(c)


@router.callback_query(F.data == "job:stop")
async def cb_stop(c: CallbackQuery):
    await do_stop(c)


@router.callback_query(F.data == "rep:last")
async def cb_report(c: CallbackQuery):
    await show(c, db.last_report() or "Abhi koi report nahi.", kb([BACK]))


@router.callback_query(F.data.startswith("mv:"))
async def cb_move(c: CallbackQuery):
    aid = int(c.data.split(":")[1])
    await c.answer("Kar raha hu...")
    try:
        res = await engine.move_to_profile(aid)
    except Exception as e:
        res = f"❌ {html.escape(str(e))}"
    await c.message.answer(res)
