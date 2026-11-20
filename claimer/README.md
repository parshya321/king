# TG Username Claimer

Ek control bot (BotFather token) jisse multiple userbot accounts (Telethon) ko manage karte ho.
Har account ki public channel par tumhara target username exact second par try hota hai.
Sab kuch bot ke inline buttons se control hota hai (commands bhi chalte hain).

## Railway setup
1. Variables: `BOT_TOKEN`, `API_ID`, `API_HASH` (my.telegram.org se).
2. Volume add karo, mount path `/data` (sessions + settings redeploy par bhi bachenge).
3. Deploy (Dockerfile use hoga). Bot me `/start` karo, jo pehle `/start` karega wahi owner banega.

## Use
- 👤 Accounts → ➕ Add (phone → code dash ke saath, jaise `1-2-3-4-5` → 2FA agar ho)
  - Account ki public channel pehle se hai to wahi use hoti hai, nahi to nayi ban jati hai.
- ⚙️ Settings: target, time (IST), gap ms, window, max attempts, lead, FloodWait notify.
- ▶️ Arm: schedule time par job chalega. ⚡ Abhi chalao: turant. ⏹ Stop.
- FloodWait aate hi bot message bhejta hai. Job ke end par full report.
- Username milne par "Profile username pe lagao" button se channel se profile par shift kar sakte ho.

## Safety
Session DB me encrypted hai (key = BOT_TOKEN + API_HASH). `/data` aur env kabhi git me mat daalna.
