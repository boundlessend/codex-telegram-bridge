# codex-telegram-bridge

Control a local Codex session from an allowlisted Telegram bot. Includes a durable
worker, macOS Keychain setup, Linux service examples and an optional Codex skill.

## Requirements

- Node.js **24** and Python **3.10+**
- A Telegram bot token from [BotFather](https://t.me/BotFather) and your numeric user ID
- For outgoing PNG/JPEG/PDF files: `exiftool`; PDF also needs `qpdf`

Use Node.js 24: Node.js 26 has a known Telegraf multipart upload issue.

## Install

```sh
git clone https://github.com/boundlessend/codex-telegram-bridge.git ~/codex-telegram-bridge
cd ~/codex-telegram-bridge
npm ci
export PATH="$PWD/node_modules/.bin:$PATH"
codex login
```

The checkout includes its own Codex CLI. Choose an existing trusted Git project
as the working directory. Stop any older bridge using the same Telegram bot.

### macOS

```sh
python3 runtime/setup.py --workdir /absolute/path/to/your/git-project
```

Enter the token into the hidden terminal prompt and provide your user ID. Setup
checks Telegram and a read-only Codex response using your account, then stores
the token in Keychain. Answer `yes` to enable login autostart.

```sh
python3 runtime/manage.py doctor
python3 runtime/manage.py status
python3 runtime/manage.py restart
```

### Linux

```sh
cp .env.minimal.example .env
chmod 600 .env
```

Edit `.env`: set `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS`, `CODEX_WORKDIR` and
`CODEX_TELEGRAM_STATE_DIR`. Use absolute paths and keep state outside the checkout.
Run `npm run start:worker` and `npm start` in separate terminals. For autostart,
follow the [systemd setup](docs/setup.md#linux-autostart).

## Use

Open your bot, send `/start`, then a small task. Verify the complete connection
with `Reply exactly TELEGRAM_CODEX_OK without tools`.

`/menu`, `/new`, `/resume`, `/queue`, `/settings`, `/status`, `/doctor` and `/stop`
cover normal operation. `/settings` also selects the interface language.

Defaults are `workspace-write` and `on-request`. Full Access is available with
confirmations retained. Interactive approval requests cannot be accepted from
Telegram; perform those operations locally. Keep credentials, logs and state
out of Git. `/cleanup_uploads` previews files; deletion requires
`Confirm upload cleanup`.

Image artifacts belong in the project's `outputs/` folder. Files are cleaned
before sending; GIF/WebP are refused. Cleaning does not redact private content.
See [setup and configuration](docs/setup.md) and the [security model](docs/security-model.md).

## Optional skill and development

Copy `skills/codex-telegram-bridge` into `~/.codex/skills/` and reopen Codex.
Invoke `$codex-telegram-bridge` with the checkout path for maintenance help.

```sh
npm run verify
npm run audit:ci
```

Tests require OpenSSL. CI verifies Linux and macOS on Node.js 24. See
[architecture](docs/architecture.md), [release checks](docs/release-checklist.md)
and [rollback](docs/rollback.md).

## License

Original additions: [BSD-3-Clause](LICENSE). Incorporated
[upstream code](https://github.com/woosungchoi/codex-telegram-bot) retains
[MIT](LICENSES/MIT-upstream.txt); preserve both notices and [NOTICE](NOTICE).
This is a community project, unaffiliated with OpenAI or Telegram.
