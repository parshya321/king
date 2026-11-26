import asyncio
import logging
import time

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.fsm.storage.memory import MemoryStorage

from . import bot as botmod
from .config import BOT_TOKEN, DB_PATH
from .db import DB
from .engine import Engine


async def main():
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("telethon").setLevel(logging.WARNING)  # 'Got difference' jaisi shor wali lines band
    bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode="HTML"))
    db = DB(DB_PATH)

    async def notify(text, rows=None):
        await botmod.notify(bot, text, rows)

    engine = Engine(db, notify)
    botmod.db = db
    botmod.engine = engine
    asyncio.create_task(engine.start_all_listeners())  # OTP/login-code forward, sab accounts ke liye
    # Deploy hote hi: jin accounts pe username nahi, unpe apne aap 5-letter laga do (quiet; skip wale fast)
    engine._ch_task = asyncio.create_task(engine.set_missing_account_usernames(quiet=True))

    # Redeploy ke baad armed job wapas chalu
    ep = engine.armed_epoch()
    if ep and db.get("armed_forever") == "1":
        engine.arm(time.time(), forever=True)
        await notify("♻️ Redeploy ke baad job wapas chalu ho gaya (target " f"@{db.get('target')}).")
    elif ep:
        if time.time() < ep + db.int("window_s"):
            engine.arm(ep)
            await notify("♻️ Redeploy ke baad armed job restore ho gaya.")
        else:
            db.set("armed_epoch", "")

    dp = Dispatcher(storage=MemoryStorage())
    dp.include_router(botmod.router)
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
