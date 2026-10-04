# Rollback

Keep the previous known-good commit and a local snapshot before changing a
running installation. Back up state, runtime settings and local `.env` outside
Git; they can contain private content. Preserve the current Keychain credential.

Stop new jobs and reconcile unfinished jobs before stopping services. For a
managed installation on either platform use `python3 runtime/manage.py stop`
or the bridge CLI's `stop` action. For a legacy manual Linux installation use
`systemctl --user stop codex-telegram-bot codex-telegram-worker`.

Obtain the verified previous commit in a checkout and run `npm ci`. For a managed
installation, rerun its local setup wizard to select that version and regenerate
the matching service definitions. Reuse the saved token/owner binding; credentials
must stay in the local terminal. Installed runtime copies in the private `apps/`
folder remain independent of the plugin cache.
Keep current state unless a diagnosed migration issue requires restoring a
compatible snapshot. Do not overwrite undelivered results without inspecting
them locally. State snapshots alone may not contain every worker event.

Start managed services with `python3 runtime/manage.py start` on either platform.
Legacy manual Linux installations use
`systemctl --user start codex-telegram-worker codex-telegram-bot`.
Inspect service status, polling and one small Telegram command. Do not repeat
a task whose external effects or delivery outcome remain uncertain.

The managed app path remains stable until deliberately reconfigured. Moving a
checkout or updating/removing its plugin does not move the installed daemon.
Repository updates do not automatically deploy or restart it.
