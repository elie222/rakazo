import type { KeyObject } from "node:crypto";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

/** Public half of the key the release workflow signs Linux AppImages with. */
export const LINUX_UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAklTbtzcfz7ZoFLioFRxwpa97Zs/N4/8oZNblx2Dfi/4=
-----END PUBLIC KEY-----
`;

const RELEASES = "https://github.com/elie222/rakazo/releases/download";
const MAX_SIGNATURE_BYTES = 1_024;
const UPDATE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.AppImage$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

/**
 * Signing a short message instead of the AppImage keeps verification streaming. The version is
 * signed so a feed cannot relabel an older signed build as a newer release.
 */
export function linuxUpdateSignatureMessage(version: string, fileName: string, sha512Hex: string) {
  return Buffer.from(`rakazo-linux-update-v1\n${version}\n${fileName}\n${sha512Hex}\n`, "utf8");
}

export async function sha512File(file: string) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function verifyLinuxUpdate(
  file: string,
  signature: string,
  version: string,
  publicKey: KeyObject | string = LINUX_UPDATE_PUBLIC_KEY,
) {
  const fileName = path.basename(file);
  const encoded = signature.trim();
  if (!VERSION.test(version) || !UPDATE_FILE.test(fileName) || !SIGNATURE.test(encoded))
    return false;
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  if (key.asymmetricKeyType !== "ed25519") return false;
  const message = linuxUpdateSignatureMessage(version, fileName, await sha512File(file));
  return verify(null, message, key, Buffer.from(encoded, "base64"));
}

export type SignatureFetch = (url: string) => Promise<Response>;

/** Reads the `.sig` published beside the AppImage in the official release. */
export async function fetchLinuxUpdateSignature(
  version: string,
  fileName: string,
  fetchUrl: SignatureFetch,
) {
  if (!VERSION.test(version) || !UPDATE_FILE.test(fileName)) {
    throw new Error("Linux update signature cannot be located.");
  }
  const response = await fetchUrl(`${RELEASES}/v${version}/${fileName}.sig`);
  if (!response.ok || response.body === null) {
    throw new Error("Linux update signature is missing.");
  }
  if (Number(response.headers.get("content-length") ?? 0) > MAX_SIGNATURE_BYTES) {
    await response.body.cancel();
    throw new Error("Linux update signature is too large.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_SIGNATURE_BYTES) throw new Error("Linux update signature is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Fails closed: an update without a valid signature is removed before it can be installed. */
export async function verifyDownloadedLinuxUpdate(
  payload: { version: string; downloadedFile: string },
  fetchUrl: SignatureFetch,
  publicKey: KeyObject | string = LINUX_UPDATE_PUBLIC_KEY,
) {
  try {
    const signature = await fetchLinuxUpdateSignature(
      payload.version,
      path.basename(payload.downloadedFile),
      fetchUrl,
    );
    if (!(await verifyLinuxUpdate(payload.downloadedFile, signature, payload.version, publicKey))) {
      throw new Error("Linux update signature is invalid.");
    }
  } catch (error) {
    await rm(payload.downloadedFile, { force: true }).catch(() => undefined);
    throw error;
  }
}
