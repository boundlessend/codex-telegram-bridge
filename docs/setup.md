# Setup and configuration

Run the one-command wizard from README.md in your own interactive terminal.
Token and pairing-link input must stay out of Codex conversations and logs.
The wizard supports macOS and Linux, checks Node.js 24/Python 3.10+, installs
locked production dependencies and reuses a verified installation on repeat runs.
It never changes global Codex configuration.

## Local wizard

1. Choose an existing trusted Git project directory.
2. Complete Codex login locally if its status check requires it.
3. Enter your bot token into the hidden prompt.
4. Open the displayed one-time Telegram link within five minutes. Only a fresh,
   direct private message with that challenge can bind the owner. Webhook bots
   and a second local polling instance are refused.
5. After the read-only Codex check, choose whether to enable login autostart.

For updates, stop the bridge before rerunning setup. An empty token prompt reuses
its saved credential and existing owner binding. A different bot or owner needs
a separate runtime directory so private history cannot move to another account.

Runtime paths:

| Platform | Private runtime directory | Credentials | Services |
| --- | --- | --- | --- |
| macOS | `~/Library/Application Support/CodexTelegramBridge/` | Keychain service `codex-telegram-bridge` | `local.codex.telegram.bridge.bot/worker` |
| Linux | `$XDG_STATE_HOME/codex-telegram-bridge/` or `~/.local/state/codex-telegram-bridge/` | Owner-only `telegram.token`, mode `600` | `codex-telegram-bridge-bot/worker.service` |

`apps/` holds verified runtime copies, `settings.json` contains string settings,
`state/` contains private history and `worker.sock` is the worker connection.
`CODEX_TELEGRAM_RUNTIME_DIR` selects an explicit absolute runtime directory.
Old runtime copies remain available for rollback.

On macOS, system prerequisites can be installed with Homebrew:

```sh
brew install node@24 python exiftool qpdf
export PATH="$(brew --prefix node@24)/bin:$PATH"
```

On Linux, install Node.js 24/Python through your preferred package manager and
ensure a systemd user session is available. File-cleaning tools are optional
for text-only use. The wizard reports missing required prerequisites before
requesting the token; it does not install system-wide software silently.

## Service control

Use `codex-telegram-bridge doctor|status|start|stop|restart|uninstall` through the
README's `npx` prefix, or `node bin/codex-telegram-bridge ACTION` from a checkout.
`python3 runtime/manage.py ACTION` is also available.

Doctor checks prerequisites without retrieving the Telegram token. Status checks
native service state; neither proves Telegram delivery. Start a small task from
the paired Telegram account for that check. Uninstall unregisters only owned
bridge services and retains credentials and history. Plugin removal alone
removes its skill/cache; it does not unregister the independent daemon.

## Advanced settings

Stop services before editing `settings.json`, then start them again. Options are
documented in `.env.example`; the managed wizard uses private JSON settings
instead of dotenv. Interface languages are English, Korean, Russian and
Traditional Chinese. Models/provider defaults come from normal Codex settings.

The host approval allowlist is `on-request,untrusted` and applies to Telegram
changes and restored chat options. Full Access keeps that confirmation policy.
The bridge has no interactive approval UI; required operations must run locally.
Snapshots retain 14 days; terminal history/uploads retain 30 days. Active work
and undelivered results are protected. Global Codex cleanup is disabled by setup.

Outgoing images must be PNG/JPEG under the chosen project's `outputs/` folder.
The cleaner also supports PDF, DOCX/XLSX/PPTX, SVG and UTF-8 text/HTML/JSON/CSV.
It cleans a copy and reports actions; content, comments and embedded Office
images are not redacted. Custom cleaners require explicit `FILE_METADATA_CLEANER`.

## Manual Linux configuration

Existing manual deployments can still copy `.env.minimal.example`, edit the
allowlists and absolute paths, and run `chmod 600 .env`. Run `npm ci`, then
`npm run start:worker` and `npm start`. The legacy sample units in `systemd/`
use `codex-telegram-bot/worker.service`; the wizard uses separate bridge unit
names and does not overwrite those units. Configure absolute Node/Codex paths
when they are outside a service's PATH. dotenv does not expand `$HOME` values.
