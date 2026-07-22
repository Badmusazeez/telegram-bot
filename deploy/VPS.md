# Deploy on a Linux VPS (Ubuntu/Debian)

Run the bot 24/7 on a cheap VPS so you do not need to keep VS Code open on your PC.

## 1) Create / buy a VPS

**Where:** browser (DigitalOcean, Linode, Vultr, Hetzner, Contabo, etc.)

- OS: **Ubuntu 22.04 or 24.04**
- Size: 1 vCPU / 1 GB RAM is enough
- Region: choose one that can reach Binance (`fapi.binance.com`). If Binance returns HTTP 451, pick another region or use a VPS provider in an allowed country.

You will get:
- VPS **IP address**
- login user (often `root`)
- password or SSH key

## 2) Connect to the VPS

**Where:** your PC terminal (PowerShell, Windows Terminal, or macOS Terminal) — not VS Code project terminal required

```bash
ssh root@YOUR_VPS_IP
```

## 3) Install Node.js 20+

**Where:** VPS SSH session

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git
node -v
npm -v
```

## 4) Copy the project to the VPS

**Option A — git clone (recommended)**  
**Where:** VPS SSH session

```bash
mkdir -p /opt
cd /opt
git clone -b cursor/binance-futures-ai-trading-assistant-fd65 https://github.com/Badmusazeez/telegram-bot.git trading-assistant
cd /opt/trading-assistant
```

**Option B — upload your local folder**  
**Where:** your PC PowerShell (project folder)

```powershell
scp -r . root@YOUR_VPS_IP:/opt/trading-assistant
```

Then on the VPS:

```bash
cd /opt/trading-assistant
```

## 5) Create `.env` on the VPS

**Where:** VPS SSH session

```bash
cd /opt/trading-assistant
cp .env.example .env
nano .env
```

Paste the same values from your PC `.env`:
- `TELEGRAM_BOT_TOKEN=...`
- `TELEGRAM_ALLOWED_CHAT_IDS=...`

Save in nano: `Ctrl+O`, Enter, then `Ctrl+X`.

Install and build:

```bash
npm install
npm run build
```

## 6) Test run (optional)

**Where:** VPS SSH session

```bash
npm run start
```

You should see the bot go online. Stop with `Ctrl+C`.

**Where:** Telegram → your bot → `/start` (if you have not already)

## 7) Run 24/7 with systemd

**Where:** VPS SSH session

```bash
cp /opt/trading-assistant/deploy/trading-assistant.service /etc/systemd/system/trading-assistant.service
systemctl daemon-reload
systemctl enable trading-assistant
systemctl start trading-assistant
systemctl status trading-assistant
```

Useful commands:

```bash
journalctl -u trading-assistant -f    # live logs
systemctl restart trading-assistant   # restart
systemctl stop trading-assistant      # stop
```

## 8) Stop the PC copy

**Where:** your PC VS Code terminal

- Press `Ctrl+C` on the local `npm run start:dev`
- Only **one** instance should use the same bot token at a time

## Notes

- Keep `.env` only on the VPS (and your PC). Never commit it to GitHub.
- If Telegram commands work but scans fail with HTTP 451, your VPS region is blocked by Binance — change region/provider.
- After `git pull` updates:

```bash
cd /opt/trading-assistant
git pull
npm install
npm run build
systemctl restart trading-assistant
```
