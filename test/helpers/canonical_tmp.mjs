import fs from "node:fs";
import os from "node:os";

process.env.TMPDIR = fs.realpathSync(os.tmpdir());
