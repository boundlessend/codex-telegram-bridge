---
name: codex-telegram-bridge
description: Set up, pair, inspect or maintain the local Codex Telegram Bridge on macOS or Linux. Use for its installer, worker, service status, restarts or removal; keep all credential input in the user's own terminal.
---

# Codex Telegram Bridge

Find the plugin root containing `plugin.json`, `bin/` and `runtime/`. Read its
README.md and applicable project instructions. The installed daemon has its own
permanent runtime; it must not depend on the plugin cache remaining available.

For setup, give the user this command to run in their own terminal:

```sh
npx --yes --package github:boundlessend/codex-telegram-bridge codex-telegram-bridge setup
```

They select a Git project, enter the token through a hidden prompt, and open the
one-time Telegram pairing link. Do not execute secret-interactive setup through
assistant tools, request a token in chat, or print a stored token/pairing link.
Setup checks prerequisites and existing Codex login, verifies a real read-only
response, and asks before starting user services. Stop older polling instances
only with the user's authorization; do not disable the shared lock.

For inspection use `node <plugin-root>/bin/codex-telegram-bridge doctor` and
`status`. For authorized changes use `start`, `stop`, `restart` or `uninstall`.
These work on macOS and Linux. Uninstall unregisters owned services and retains
private data. Before removing the plugin itself, offer to unregister its daemon;
plugin removal alone leaves that independent service running.

Keep on-request or untrusted approvals. Full Access is available when explicitly
requested with confirmations retained. Never bypass safeguards or choose never.
Interactive approvals cannot be accepted through Telegram.

After changes run `npm run verify`. After a live restart inspect safe service
status and ask the user to send `Reply exactly TELEGRAM_CODEX_OK without tools`.
Distinguish prerequisites, service state, SDK response and actual Telegram delivery.
Do not print settings, credentials, full process environments, logs or session
content into the conversation. A cleaning failure must be diagnosed without
disabling cleaning. See `docs/setup.md` for runtime paths and migration details.
