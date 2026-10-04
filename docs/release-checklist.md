# Release checks

Run `npm ci`, `npm run verify`, `npm run audit:ci` and
`npm pack --dry-run --json` from a clean checkout. Inspect the package contents:
source, runtime, skill and both license notices must be present; credentials,
runtime state, logs and local backups must be absent.

Use `python3 runtime/manage.py doctor` and `status` to inspect managed
installations on either platform. These checks do not
prove end-to-end delivery. With a dedicated staging bot, test a small text
command, an output image, cancellation, queue recovery and a restart. Perform
cleanup tests only against disposable staging directories.

Check `/health`, `/whoami`, `/settings` and `/cleanup_uploads`; the latter
previews candidates and requires `Confirm upload cleanup` before deleting files.

Repository publication does not deploy the service. Public visibility, tags,
GitHub releases and package publishing each require separate authorization.
No release workflow or automatic deployment is included. npm publication is
disabled by package metadata.

Verify the packed package contains `npm-shrinkwrap.json`, the setup CLI and
`plugin.json`. Test installation from the tarball and native Codex plugin
discovery. A new marketplace entry must point at the published plugin revision.

Before changing a running installation, keep its previous source revision
and local state snapshot. Restore using the platform's service manager after
stopping new jobs. Do not resend a job whose external effects or Telegram
delivery are uncertain without reconciliation.
