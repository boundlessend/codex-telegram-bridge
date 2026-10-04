# Setup and configuration

Start with the installation commands in README.md. Keep Node.js 24 active in
PATH, including for background services. The local Codex CLI comes from `npm ci`;
`npm ci --omit=dev` does not install it. Authenticate locally with `codex login`.
Create the bot through BotFather and obtain your numeric Telegram user ID
before setup, for example with [userinfobot](https://t.me/userinfobot).
Usernames are not accepted in allowlists.

## macOS

With Homebrew, install the system prerequisites:

```sh
brew install node@24 python exiftool qpdf
export PATH="$(brew --prefix node@24)/bin:$PATH"
```

Run `runtime/setup.py --workdir PROJECT` from the checkout. The chosen project
must already be a Git repository unless you deliberately configure
`CODEX_SKIP_GIT_REPO_CHECK=true` locally. Setup validates Telegram and Codex before
changing settings or credentials. It leaves global Codex configuration intact.

The Keychain service is `codex-telegram-bridge`. Runtime settings, logs and state
live in `~/Library/Application Support/CodexTelegramBridge/`. Settings are string
environment values in `settings.json`; the bot token is stored only in Keychain.
Stop services before editing settings, then start them again:

```sh
python3 runtime/manage.py stop
python3 runtime/manage.py start
```

Use `doctor` for prerequisites and `status` for LaunchAgent registration.
Neither proves end-to-end Telegram delivery. Service labels are
`local.codex.telegram.bridge.worker` and `local.codex.telegram.bridge.bot`.
Moving the checkout or Python executable requires rerunning setup to update them.

## Linux configuration

Edit the copied `.env` locally. Required values are the token, numeric user ID
and absolute working/state directories. `CODEX_PATH` may point to your chosen
CLI; if it is outside the service PATH, use its absolute executable path.
dotenv does not expand shell variables such as `$HOME` in these values.

Install `exiftool` and `qpdf` with your distribution's package manager when
you need to send images or PDFs. Missing cleanup tools prevent sending those
files, while normal text commands remain available.

## Linux autostart

The supplied units assume the checkout is `~/codex-telegram-bridge`. Install them:

```sh
mkdir -p ~/.config/systemd/user
cp systemd/codex-telegram-{bot,worker}.service ~/.config/systemd/user/
```

Check `command -v node` and `command -v codex` from your configured terminal.
If Node.js 24 is outside the units' PATH, adjust `ExecStart` to its absolute path.
Set `CODEX_PATH` in `.env` if your chosen CLI needs an absolute path. Then enable:

```sh
systemctl --user daemon-reload
systemctl --user enable --now codex-telegram-worker codex-telegram-bot
systemctl --user status codex-telegram-worker codex-telegram-bot
```

The units use private `UMask=0077`. Keeping services running after logout may
require enabling user lingering according to the host's administration policy.

## Settings and files

Use `/settings` for model, reasoning, queue and interface preferences. UI
languages are English, Korean, Russian and Traditional Chinese. Configure model
and provider defaults through your normal Codex settings; setup pins neither.
Optional environment settings are listed in `.env.example`.

The host approval allowlist defaults to `on-request,untrusted` and applies to
both Telegram changes and restored chat options. `danger-full-access` remains
available with that policy. The bridge has no interactive approval UI; an
operation requiring approval may need to be run locally.

Snapshots retain 14 days; finished worker history and uploads retain 30 days
by default. Active work and undelivered results are protected. Global Codex
cleanup is disabled by the macOS installer; Linux's minimal config retains the
manual cleanup policy. See [runtime storage](runtime-optimization.md).

Outgoing images must be PNG/JPEG under the selected project's `outputs/` folder.
The cleaner also supports PDF, DOCX/XLSX/PPTX, SVG and UTF-8 text/HTML/JSON/CSV.
It cleans a separate copy and reports actions. GIF/WebP and unknown formats
are refused; document content, comments and embedded Office images are not
redacted. Configure a custom cleaner explicitly with `FILE_METADATA_CLEANER`.

Stop an older installation before using the same bot token. The shared lock
prevents duplicate polling, and runtime state is not imported automatically.
Use the [rollback procedure](rollback.md) when changing a running installation.
