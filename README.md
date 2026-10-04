# codex-telegram-bridge

Run Codex tasks from an allowlisted Telegram bot through a local Node.js service
and the official Codex SDK. Includes a worker, a macOS Keychain installer,
Linux systemd examples and a companion Codex skill for maintenance.
Derived from [codex-telegram-bot](https://github.com/woosungchoi/codex-telegram-bot).

## Requirements

- Node.js 24, npm, Python 3.10 or newer
- Codex CLI on PATH, authenticated locally with `codex login`
- A Telegram bot token and your numeric Telegram user ID
- For outgoing PNG/JPEG/PDF files: exiftool; PDF also requires qpdf
- For the development test suite: OpenSSL on PATH

macOS Keychain installation keeps the Telegram token outside configuration
files. Linux uses a local `.env` file with mode 600. Never commit credentials,
runtime settings, sessions, backups or logs.

## Install on macOS

```sh
git clone https://github.com/boundlessend/codex-telegram-bridge.git
cd codex-telegram-bridge
npm ci
python3 runtime/setup.py --workdir /absolute/path/to/your/project
```

Enter the token only into the hidden local terminal prompt. Setup checks
Telegram and a real read-only Codex SDK response before updating Keychain or
settings. This SDK check uses your normal Codex account. Setup asks before
enabling LaunchAgents and never modifies global Codex configuration.

The Keychain service is `codex-telegram-bridge`. Settings, logs and state live
in `~/Library/Application Support/CodexTelegramBridge/`. Service labels are
`local.codex.telegram.bridge.worker` and `local.codex.telegram.bridge.bot`.
Moving the checkout or Python executable requires rerunning setup.

```sh
python3 runtime/manage.py doctor
python3 runtime/manage.py status
python3 runtime/manage.py start
python3 runtime/manage.py stop
python3 runtime/manage.py restart
```

Doctor checks prerequisites without reading the token or contacting Telegram.
A loaded LaunchAgent does not prove polling and command delivery work. For an
end-to-end check, send the bot `Reply exactly TELEGRAM_CODEX_OK without tools`
and verify its answer.

## Install on Linux

Clone into `~/codex-telegram-bridge`, run `npm ci`, and copy
`.env.minimal.example` to `.env`. Set `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS`,
`CODEX_WORKDIR` and `CODEX_TELEGRAM_STATE_DIR` locally, then `chmod 600 .env`.
Keep state outside the checkout. Do not paste credentials into a chat.

Run `npm run start:worker` and `npm start` in separate terminals, or install
the two units from `systemd/` into `~/.config/systemd/user/` and enable them:

```sh
systemctl --user daemon-reload
systemctl --user enable --now codex-telegram-worker codex-telegram-bot
```

If Node or Codex is outside the units' PATH, adjust the units locally before
installation. The Keychain installer and macOS manager are macOS-only.

## Controls and boundaries

Use `/menu`, `/new`, `/resume`, `/status`, `/queue`, `/settings`, `/stop`,
`/doctor` and `/help`. UI languages include English and Korean. Codex can
answer in the language specified by your own project instructions.

Defaults are `workspace-write` and `on-request`. The host approval allowlist
is `on-request,untrusted`; Telegram cannot select `never` through that boundary.
`danger-full-access` remains available with confirmation policy retained.
The bridge has no interactive Telegram approval buttons: SDK requests requiring
approval cannot be accepted remotely; app-server requests are explicitly
declined. Perform blocked operations locally when necessary. Full Access can
still execute actions the selected policy considers already allowed, so choose
the working directory carefully.

A shared per-bot lock prevents concurrent polling instances. Stop an older
installation before starting this one with the same bot. Runtime state is not
imported automatically. Job logs and attachment retention default to 30 days;
snapshots default to 14 days. Undelivered results are protected. Global Codex
cleanup is disabled by the macOS installer.

`/cleanup_uploads` previews expired uploads without deleting them. Deletion
requires the `Confirm upload cleanup` button; use disposable data for testing.

Outgoing image artifacts must be in the selected project's `outputs/` folder.
The cleaner processes a separate copy and reports its actions. Supported
formats are PNG/JPEG, PDF, DOCX/XLSX/PPTX, SVG and UTF-8 text/HTML/JSON/CSV.
GIF/WebP and unknown formats are refused. Cleaning removes common embedded
metadata and invisible markers; it does not redact visible private content,
comments, tracked changes, embedded Office images or steganography. Failed
cleaning prevents sending the file. Select custom cleaners locally with
`FILE_METADATA_CLEANER`.

## Companion skill

Copy `skills/codex-telegram-bridge` into `~/.codex/skills/`, then reopen Codex.
Ask `$codex-telegram-bridge` to inspect or maintain the bridge and supply the
checkout path. The skill uses runtime tools; it does not run a Telegram service
itself. Installing it is optional.

## Development

```sh
npm ci
npm run verify
npm run audit:ci
```

Tests use synthetic fixtures and real filesystem/process checks. CI runs on
Linux and macOS with Node.js 24 and uses no Telegram token. It does not exercise
an owner's live bot. See [architecture](docs/architecture.md),
[security model](docs/security-model.md), [release checks](docs/release-checklist.md)
and [rollback](docs/rollback.md).
Node.js 26 currently has an inherited Telegraf multipart upload compatibility
issue; use Node.js 24 for the service.

## License

Original work is BSD-3-Clause (New BSD). Incorporated upstream code retains MIT
attribution and conditions. Distribution must retain both notices:
[LICENSE](LICENSE), [MIT upstream license](LICENSES/MIT-upstream.txt), [NOTICE](NOTICE).
The package SPDX expression is `BSD-3-Clause AND MIT`. npm publication is
disabled with `private: true`; GitHub visibility is configured separately.
