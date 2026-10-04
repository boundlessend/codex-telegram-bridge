import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-setup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the one-command manager exposes setup and rejects non-interactive token input", async (t) => {
  const home = await fixture(t);
  const environment = { ...process.env, HOME: home, CODEX_TELEGRAM_RUNTIME_DIR: path.join(home, "runtime") };
  const help = await run(process.execPath, [path.join(root, "bin/codex-telegram-bridge"), "--help"], { env: environment });
  assert.match(help.stdout, /setup.*doctor.*uninstall/);
  await assert.rejects(run(process.execPath, [path.join(root, "bin/codex-telegram-bridge"), "setup"], { env: environment }), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /own interactive terminal/);
    return true;
  });
  assert.deepEqual(await fs.readdir(home), []);
});

test("configuration rollback restores real Linux credential and settings files", async (t) => {
  const home = await fixture(t);
  const script = `
import json
from pathlib import Path
import sys
sys.platform = 'linux'
sys.path.insert(0, sys.argv[1])
from install import Tools
from runtime import STATE_ROOT, RuntimeConfigurationError, atomic_write, ensure_private_directory, read_credential, read_settings, write_credential
from services import ServiceManager, service_file
from setup import commit_configuration
ensure_private_directory(STATE_ROOT)
app = STATE_ROOT / 'apps' / 'fixture'
app.mkdir(parents=True)
(app / 'package.json').write_text('{}')
old = {'ALLOWED_USER_IDS': '42'}
atomic_write(STATE_ROOT / 'settings.json', json.dumps(old).encode())
write_credential('123:fixture')
unit = service_file('bot', 'linux', Path.home())
unit.parent.mkdir(parents=True)
unit.write_bytes(b'previous service definition')
class UnavailableManager(ServiceManager):
    def __init__(self):
        super().__init__('linux', Path.home())
        self.calls = 0
    def reload(self):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeConfigurationError('systemd unavailable')
manager = UnavailableManager()
settings = {'ALLOWED_USER_IDS': '43', 'CODEX_TELEGRAM_APP_ROOT': str(app), 'CODEX_TELEGRAM_NODE': sys.argv[2]}
try:
    commit_configuration(settings, '123:changedfixture', Tools(Path(sys.argv[2]), Path('/usr/bin/npm'), Path(sys.executable)), manager)
except RuntimeConfigurationError:
    pass
else:
    raise AssertionError('Unavailable systemd must fail setup')
assert read_settings() == old
assert read_credential() == '123:fixture'
assert (STATE_ROOT / 'telegram.token').stat().st_mode & 0o777 == 0o600
assert unit.read_bytes() == b'previous service definition'
assert not service_file('worker', 'linux', Path.home()).exists()
`;
  await run("python3", ["-c", script, path.join(root, "runtime"), process.execPath], {
    env: { ...process.env, HOME: home, CODEX_TELEGRAM_RUNTIME_DIR: path.join(home, "runtime") }
  });
});

test("both service formats keep credentials out and quote permanent runtime paths", async (t) => {
  const home = await fixture(t);
  await run("python3", ["-c", `
from pathlib import Path
import plistlib
import sys
sys.path.insert(0, sys.argv[1])
from services import launch_agent, systemd_unit
root = Path(sys.argv[2]) / 'an app with spaces'
root.mkdir()
(root / 'package.json').write_text('{}')
settings = {'CODEX_TELEGRAM_APP_ROOT': str(root), 'CODEX_TELEGRAM_NODE': sys.argv[3]}
agent = plistlib.loads(launch_agent('bot', settings, Path(sys.executable)))
assert agent['WorkingDirectory'] == str(root)
assert 'TELEGRAM_BOT_TOKEN' not in agent['EnvironmentVariables']
unit = systemd_unit('bot', settings, Path(sys.executable)).decode()
assert 'UMask=0077' in unit
assert 'TELEGRAM_BOT_TOKEN' not in unit
assert 'EnvironmentFile' not in unit
assert 'run_bot.py"' in unit
assert 'codex-telegram-bridge-worker.service' in unit
`, path.join(root, "runtime"), home, process.execPath], {
    env: { ...process.env, HOME: home, CODEX_TELEGRAM_RUNTIME_DIR: path.join(home, "runtime") }
  });
});

test("packed GitHub runtime includes its lock and installs outside the package cache", { timeout: 180_000 }, async (t) => {
  const directory = await fixture(t);
  const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: root, timeout: 30_000 });
  const [packed] = JSON.parse(stdout);
  assert.ok(packed.files.some((file) => file.path === "npm-shrinkwrap.json"));
  assert.ok(packed.files.some((file) => file.path === "plugin.json"));
  assert.equal(packed.files.some((file) => file.path.endsWith(".pyc") || file.path.startsWith("state/")), false);
  await run("tar", ["-xzf", path.join(directory, packed.filename), "-C", directory]);
  const source = path.join(directory, "package");
  const state = path.join(directory, "owned-state");
  const installed = await run("python3", ["-c", `
from pathlib import Path
import shutil
import sys
sys.path.insert(0, sys.argv[1])
from install import Tools, prepare_runtime, runtime_digest
from runtime import STATE_ROOT
tools = Tools(Path(sys.argv[2]), Path(shutil.which('npm')), Path(sys.executable))
app = prepare_runtime(Path(sys.argv[3]), tools, {})
assert app.is_relative_to(STATE_ROOT / 'apps')
assert app != Path(sys.argv[3])
assert not (app / '.git').exists()
assert not (app / 'state').exists()
assert not (app / 'test').exists()
assert (app / 'node_modules/.bin/codex').is_file()
assert runtime_digest(app) == runtime_digest(Path(sys.argv[3]))
again = prepare_runtime(Path(sys.argv[3]), tools, {'CODEX_TELEGRAM_APP_ROOT': str(app)})
assert again == app
print(app)
`, path.join(source, "runtime"), process.execPath, source], {
    env: { ...process.env, CODEX_TELEGRAM_RUNTIME_DIR: state }, timeout: 150_000
  });
  const app = installed.stdout.trim().split("\n").at(-1);
  const version = await run(path.join(app, "node_modules/.bin/codex"), ["--version"], { timeout: 10_000 });
  assert.match(version.stdout, /^codex-cli /);
});
