# Rollback

Keep the previous known-good commit and a local snapshot before changing a
running installation. Back up state, runtime settings and local `.env` outside
Git; they can contain private content. Preserve the current Keychain credential.

Stop new jobs and reconcile unfinished jobs before stopping services. On macOS
run `python3 runtime/manage.py stop`. On Linux run
`systemctl --user stop codex-telegram-bot codex-telegram-worker`.

Switch the local checkout to the verified previous commit and run `npm ci`.
Keep current state unless a diagnosed migration issue requires restoring a
compatible snapshot. Do not overwrite undelivered results without inspecting
them locally. State snapshots alone may not contain every worker event.

On macOS restart with `python3 runtime/manage.py start`. On Linux use
`systemctl --user start codex-telegram-worker codex-telegram-bot`.
Inspect service status, polling and one small Telegram command. Do not repeat
a task whose external effects or delivery outcome remain uncertain.

The checkout path must remain unchanged for installed LaunchAgents. If it moves,
rerun setup deliberately to update service paths. Repository changes do not
automatically restart or deploy a running bot.
