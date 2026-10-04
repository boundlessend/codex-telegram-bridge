# codex-telegram-bridge

Control local Codex tasks from Telegram with a durable worker, secure account
pairing and private runtime storage. Supports macOS and Linux.

## Install

Requires **Node.js 24**, **npm** and **Python 3.10+**. Linux autostart uses a
systemd user session. Create your bot through [BotFather](https://t.me/BotFather),
then run this in your own terminal:

```sh
npx --yes --package github:boundlessend/codex-telegram-bridge codex-telegram-bridge setup
```

The wizard asks for a trusted Git project and a hidden bot token. Open its
one-time Telegram link to bind your account, then choose whether to start the
services automatically. No numeric user ID, `.env` editing or manual service
files are needed. It checks your existing Codex login and offers login only
when required; the read-only SDK check uses your normal account.

Stop an older bridge polling the same bot before pairing. Dependencies and
runtime code are installed in a permanent private folder outside plugin caches.
For repeat commands, use the same `npx` prefix with `doctor`, `status`, `start`,
`stop`, `restart` or `uninstall` instead of `setup`.

## Codex plugin

The plugin is available through Senya Plugins:

```sh
codex plugin marketplace add boundlessend/yougile-tracking
codex plugin marketplace upgrade senya-plugins
codex plugin add codex-telegram-bridge@senya-plugins
```

Invoke `$codex-telegram-bridge` for setup or maintenance help. The skill keeps
token input in your local terminal. Removing the plugin does not stop its
independent daemon: run the bridge's `uninstall` command first when retiring it.
Uninstall unregisters user services and keeps local settings and history.

## Use

Send `/start`, then a small task. Verify complete delivery with
`Reply exactly TELEGRAM_CODEX_OK without tools`.

Use `/menu`, `/new`, `/resume`, `/queue`, `/settings`, `/status`, `/doctor` and
`/stop`. Defaults are `workspace-write` and `on-request`. Full Access remains
available with confirmations retained. Interactive approvals cannot be accepted
from Telegram; perform those operations locally.

Images belong in the project's `outputs/` folder. File metadata is cleaned
before sending; PNG/JPEG/PDF require `exiftool`, and PDF also needs `qpdf`.
GIF/WebP are refused. Cleaning does not redact private content.
`/cleanup_uploads` previews files; deletion requires `Confirm upload cleanup`.

See [setup and configuration](docs/setup.md), [security](docs/security-model.md)
and [rollback](docs/rollback.md). Keep credentials, state and logs out of Git.

## Development

```sh
npm ci
npm run verify
npm run audit:ci
```

CI verifies macOS and Linux on Node.js 24. Tests require OpenSSL. See
[architecture](docs/architecture.md) and [release checks](docs/release-checklist.md).
Node.js 26 has a known Telegraf multipart upload issue; the wizard requires 24.

## License

Original additions: [BSD-3-Clause](LICENSE). Incorporated
[upstream code](https://github.com/woosungchoi/codex-telegram-bot) retains
[MIT](LICENSES/MIT-upstream.txt); preserve both notices and [NOTICE](NOTICE).
This is a community project, unaffiliated with OpenAI or Telegram.
