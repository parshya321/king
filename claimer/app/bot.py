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
    edit = State()
    chan = State()


# ---------- helpers ----------
def kb(rows) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text=t, callback_data=d) for t, d in row] for row in rows]
    )


MAIN_KB = kb([
    [("👤 Accounts", "acc:list"), ("⚙️ Settings", "set:menu")],
    [("▶️ Arm (schedule pe)", "job:arm"), ("⚡ Abhi chalao", "job:now")],
    [("⏹ Stop", "job:stop"), ("📡 Status", "m:status")],
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


def settings_view():
    g = db.get
    text = (
        "⚙️ <b>Settings</b>\n\n"
        f"🎯 Target: <code>@{html.escape(g('target') or '—')}</code>\n"
        f"🕒 Time (IST): <code>{html.escape(g('sched') or '—')}</code>\n"
        f"⏱ Gap: <b>{g('gap_ms')} ms</b> (har account ke 2 tries ke beech)\n"
        f"🪟 Window: <b>{g('window_s')} s</b> (schedule ke baad itni der try)\n"
        f"🔢 Max attempts/account: <b>{g('max_att')}</b> (0 = unlimited)\n"
        f"🚀 Lead: <b>{g('lead_s')} s</b> (schedule se itna pehle accounts ready)\n"
        f"🔔 FloodWait notify: <b>{'ON' if g('notify') == '1' else 'OFF'}</b>"
    )
    rows = [
        [("🎯 Target", "edit:target"), ("🕒 Time", "edit:sched")],
        [("➖50", "adj:gap_ms:-50"), ("⏱ Gap ✏️", "edit:gap_ms"), ("➕50", "adj:gap_ms:50")],
        [("➖15", "adj:window_s:-15"), ("🪟 Window ✏️", "edit:window_s"), ("➕15", "adj:window_s:15")],
        [("➖10", "adj:max_att:-10"), ("🔢 Max ✏️", "edit:max_att"), ("➕10", "adj:max_att:10")],
        [("➖5", "adj:lead_s:-5"), ("🚀 Lead ✏️", "edit:lead_s"), ("➕5", "adj:lead_s:5")],
        [(f"🔔 Notify: {'ON' if g('notify') == '1' else 'OFF'}", "tog:notify")],
        BACK,
    ]
    return text, kb(rows)


async def screen_settings(ev):
    t, m = settings_view()
    await show(ev, t, m)


async def screen_accounts(ev):
    accs = db.accounts()
    rows = [[(f"{'✅' if a['active'] else '⏸'} {a['name'] or a['phone']}", f"acc:{a['id']}")] for a in accs]
    rows.append([("➕ Account add", "acc:add")])
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


@router.message(Command("report"))
async def cmd_report(m: Message):
    await m.answer(db.last_report() or "Abhi koi report nahi.", reply_markup=kb([BACK]))


@router.message(Command("stop"))
async def cmd_stop(m: Message):
    await do_stop(m)


@router.message(Command("arm"))
async def cmd_arm(m: Message):
    await do_arm(m, now=False)


# ---------- callbacks ----------
@router.callback_query(F.data == "m:main")
async def cb_main(c: CallbackQuery, state: FSMContext):
    await state.clear()
    await screen_main(c)


@router.callback_query(F.data == "m:status")
async def cb_status(c: CallbackQuery):
    await screen_status(c)


@router.callback_query(F.data == "set:menu")
async def cb_settings(c: CallbackQuery, state: FSMContext):
    await state.clear()
    await screen_settings(c)


@router.callback_query(F.data.startswith("adj:"))
async def cb_adj(c: CallbackQuery):
    _, key, delta = c.data.split(":")
    floor = {"gap_ms": 1, "window_s": 1, "max_att": 0, "lead_s": 0}[key]
    db.set(key, max(floor, db.int(key) + int(delta)))
    await screen_settings(c)


@router.callback_query(F.data == "tog:notify")
async def cb_tog(c: CallbackQuery):
    db.set("notify", "0" if db.get("notify") == "1" else "1")
    await screen_settings(c)


PROMPTS = {
    "target": "🎯 Target username bhejo (bina @, 5-32 chars):",
    "sched": "🕒 Time (IST) bhejo.\nFormat: <code>HH:MM:SS</code> ya <code>HH:MM:SS.mmm</code>\n"
             "Dusre din ke liye: <code>DD-MM-YYYY HH:MM:SS</code>",
    "gap_ms": "⏱ Gap milliseconds me bhejo (jaise 500):",
    "window_s": "🪟 Window seconds me bhejo (jaise 120):",
    "max_att": "🔢 Max attempts per account bhejo (0 = unlimited):",
    "lead_s": "🚀 Lead seconds bhejo (jaise 15):",
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
    else:
        if not v.isdigit() or (key != "max_att" and int(v) < 1):
            return await m.answer("❌ Sahi number bhejo:")
    db.set(key, v)
    await state.clear()
    await screen_settings(m)


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


@router.callback_query(F.data.startswith("acc:del:"))
async def cb_acc_del(c: CallbackQuery):
    parts = c.data.split(":")
    aid = int(parts[2])
    if len(parts) == 3:
        return await show(c, "Pakka remove karna hai? Session bhi delete ho jayega.",
                          kb([[("✅ Haan, delete", f"acc:del:{aid}:y"), ("❌ Nahi", f"acc:{aid}")]]))
    await engine.drop_client(aid)
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
async def do_arm(ev, now: bool):
    if not db.get("target"):
        return await show(ev, "❌ Pehle Settings me Target username set karo.", kb([BACK]))
    if not db.accounts(only_active=True):
        return await show(ev, "❌ Koi active account nahi. Pehle account add karo.", kb([BACK]))
    if engine.busy:
        return await show(ev, "⚠️ Job pehle se armed/chal raha hai. Pehle Stop karo.", kb([BACK]))
    if now:
        epoch = time.time()
    else:
        epoch = sched_epoch(db.get("sched"))
        if not epoch:
            return await show(ev, "❌ Pehle Settings me Time set karo.", kb([BACK]))
    engine.arm(epoch)
    await show(ev, f"🟢 <b>Armed</b>\nTarget: <code>@{db.get('target')}</code>\n"
                   f"Shuru: <b>{fmt_ts(epoch)} IST</b> ({max(0, epoch - time.time()):.0f}s baad)\n"
                   f"Gap: {db.get('gap_ms')}ms | Window: {db.get('window_s')}s",
               kb([[("⏹ Stop", "job:stop")], BACK]))


async def do_stop(ev):
    if not engine.busy:
        return await show(ev, "Koi job nahi chal raha.", kb([BACK]))
    engine.disarm_task()
    await show(ev, "⏹ Stop ho gaya.", kb([BACK]))


@router.callback_query(F.data == "job:arm")
async def cb_arm(c: CallbackQuery):
    await do_arm(c, now=False)


@router.callback_query(F.data == "job:now")
async def cb_now(c: CallbackQuery):
    await do_arm(c, now=True)


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
