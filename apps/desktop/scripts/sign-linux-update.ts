// Writes `<AppImage>.sig` for each AppImage in argv[4..], signed for release version argv[3] with
// the Ed25519 key at argv[2], then
// checks it against the public key the app embeds.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  linuxUpdateSignatureMessage,
  sha512File,
  verifyLinuxUpdate,
} from "../src/linux-update-signature.js";

const [keyFile = "", version = "", ...images] = process.argv.slice(2);
const key = createPrivateKey(readFileSync(keyFile));
if (
  key.asymmetricKeyType !== "ed25519" ||
  !/^\d+\.\d+\.\d+$/.test(version) ||
  images.length === 0
) {
  console.error("Usage: sign-linux-update.ts <ed25519-key.pem> <version> <file.AppImage>...");
  process.exit(1);
}
for (const image of images) {
  const message = linuxUpdateSignatureMessage(
    version,
    path.basename(image),
    await sha512File(image),
  );
  const signature = `${sign(null, message, key).toString("base64")}\n`;
  if (!(await verifyLinuxUpdate(image, signature, version))) {
    console.error(`${path.basename(image)} does not verify with the app's Linux update key.`);
    process.exit(1);
  }
  writeFileSync(`${image}.sig`, signature);
}
