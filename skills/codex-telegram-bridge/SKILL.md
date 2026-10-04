---
name: codex-telegram-bridge
description: Set up, inspect, troubleshoot or maintain a local codex-telegram-bridge service that receives Codex commands through an allowlisted Telegram bot. Use when the user asks about this bridge, its worker, Keychain setup, service status or restarting its installation.
---

# Codex Telegram Bridge

Ask for the repository checkout path if unknown. Read its README.md and project
instructions before acting. Do not assume a personal directory or copy settings
from another bridge installation.

On macOS use `python3 runtime/manage.py doctor` for prerequisites and
`python3 runtime/manage.py status` for LaunchAgent registration. Doctor does
not read credentials. Status alone does not prove Telegram polling is healthy.

For setup, guide the user to run `python3 runtime/setup.py --workdir PROJECT`
from the checkout in their terminal. Token input belongs only in the hidden
local prompt, never in chat, tool output or an assistant-generated command
argument. The installer checks Telegram and Codex before saving credentials
and asks before enabling autostart. It does not modify global Codex settings.

For an authorized service change use `python3 runtime/manage.py start`, `stop`
or `restart`. These control only the bridge's macOS labels. On Linux read the
systemd units and README instead. Before starting, establish whether another
installation polls the same bot; stop it only with the user's authorization.
Do not disable the shared instance lock.

Keep approval policy on-request or untrusted. Full Access remains possible when
explicitly requested with confirmations retained. Never select approval never
or silently bypass safeguards. The bridge cannot accept interactive approvals
from Telegram; required operations may need to be performed locally.

After code changes run `npm run verify`. After a live restart inspect safe startup
status locally, then ask the user to send `Reply exactly TELEGRAM_CODEX_OK without
tools` from Telegram. Distinguish prerequisites, loaded services, polling,
Codex SDK response and actual end-to-end delivery in the report.

Do not print settings.json, dotenv contents, tokens, session content or process
environments. Do not publish state, logs or backups. Investigate cleaning
failures locally without disabling cleaning. Updating source, restarting services
and publishing a repository are separate user actions.
