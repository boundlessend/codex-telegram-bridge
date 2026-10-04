# Security model

Authorization checks numeric user, chat and optional topic allowlists before
processing Telegram updates. Private conversations and groups have distinct
allowlist rules. A compromised allowed Telegram account can still issue tasks;
this service has no second factor or independent user confirmation UI.

Normal tasks retain on-request or untrusted approval policy by default. The
host allowlist restricts Telegram policy changes; only a local operator can
change that boundary. Side tasks use read-only mode without extra writable
directories. Full Access weakens filesystem isolation and remains an explicit
user choice. App-server approval requests are declined rather than accepted.

Persistent queues, atomic state files and per-part receipts support restart
recovery. Ambiguous Telegram sends require reconciliation; automatic retries
are limited to definitive rate-limit rejections. Telegram cannot guarantee
exactly-once delivery or recipient read confirmation.

Worker admission, UTF-8 framing, per-bot locks, socket ownership checks and
idle watchdogs bound common failure modes. They do not guarantee that every
external tool terminates or every task succeeds. Inspect failed jobs locally
before retrying actions that may already have changed external state.

Credentials remain in local Keychain on macOS or a restricted dotenv file on
Linux. Snapshots and logs contain user content and must remain local. Retention
protects undelivered results, which can outlive the nominal retention period.
Metadata cleaning does not redact content, comments, tracked changes, embedded
Office images or steganography. Do not send a file containing private content
merely because cleaning passed.

`/cleanup_uploads` does not delete files until the user presses
`Confirm upload cleanup`. Scheduled retention is a separate configured policy.

The inherited Linux Codex updater and other advanced operations remain available.
Their live behavior is separate from macOS service setup. Read their documentation
and obtain explicit local authorization before invoking them.
