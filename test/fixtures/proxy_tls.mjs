import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Generate isolated test credentials in memory; no private key is stored in Git.
const pair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});

export const key = pair.privateKey;
export const cert = createFixtureCertificate(key);

function createFixtureCertificate(privateKey) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bridge-tls-"));
  const file = path.join(directory, "fixture.key");
  try {
    writeFileSync(file, privateKey, { mode: 0o600, flag: "wx" });
    return execFileSync("openssl", [
      "req", "-new", "-x509", "-key", file, "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } finally {
    unlinkSync(file);
    rmdirSync(directory);
  }
}
