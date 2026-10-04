import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";

// Generate isolated test credentials in memory; no private key is stored in Git.
const pair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});

export const key = pair.privateKey;
export const cert = execFileSync("openssl", [
  "req", "-new", "-x509", "-key", "/dev/stdin", "-days", "1",
  "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"
], { input: key, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
