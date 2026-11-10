/**
 * Small hashing primitives for WebDAV backup, with no native dependency:
 * the app has no crypto module that hashes a file, and the backup manifest
 * needs a SHA-256 of the exported zip. Both are pure TypeScript and covered
 * by known-answer tests; the SHA-256 feeds on stream chunks so a large zip
 * never sits in JS memory at once.
 */

/** UTF-8 bytes for a string, without depending on a TextEncoder global. */
export function utf8Bytes(input: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code < 0xdc00) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next < 0xe000) {
        const point = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        bytes.push(
          0xf0 | (point >> 18),
          0x80 | ((point >> 12) & 0x3f),
          0x80 | ((point >> 6) & 0x3f),
          0x80 | (point & 0x3f),
        );
        i += 1;
      } else {
        bytes.push(0xef, 0xbf, 0xbd);
      }
    } else if (code >= 0xdc00 && code < 0xe000) {
      bytes.push(0xef, 0xbf, 0xbd);
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr32(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export type Sha256Digest = {
  update(chunk: Uint8Array): void;
  digest(): string;
};

/** Incremental SHA-256; the digest is lowercase hex. One instance, one file. */
export function createSha256(): Sha256Digest {
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const block = new Uint8Array(64);
  let blockLength = 0;
  let totalLength = 0;
  let finished = false;

  function processBlock(offset: number): void {
    const w = new Array<number>(64);
    for (let i = 0; i < 16; i += 1) {
      w[i] =
        (block[offset + i * 4]! << 24) |
        (block[offset + i * 4 + 1]! << 16) |
        (block[offset + i * 4 + 2]! << 8) |
        block[offset + i * 4 + 3]!;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr32(w[i - 15]!, 7) ^ rotr32(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr32(w[i - 2]!, 17) ^ rotr32(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = state as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) | 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    state[0] = (state[0]! + a) | 0;
    state[1] = (state[1]! + b) | 0;
    state[2] = (state[2]! + c) | 0;
    state[3] = (state[3]! + d) | 0;
    state[4] = (state[4]! + e) | 0;
    state[5] = (state[5]! + f) | 0;
    state[6] = (state[6]! + g) | 0;
    state[7] = (state[7]! + h) | 0;
  }

  return {
    update(chunk: Uint8Array): void {
      if (finished) throw new Error("SHA-256 is already finished");
      totalLength += chunk.length;
      let offset = 0;
      if (blockLength > 0) {
        const needed = 64 - blockLength;
        const take = Math.min(needed, chunk.length);
        block.set(chunk.subarray(0, take), blockLength);
        blockLength += take;
        offset = take;
        if (blockLength === 64) {
          processBlock(0);
          blockLength = 0;
        }
      }
      while (chunk.length - offset >= 64) {
        block.set(chunk.subarray(offset, offset + 64), 0);
        processBlock(0);
        offset += 64;
      }
      if (offset < chunk.length) {
        block.set(chunk.subarray(offset), 0);
        blockLength = chunk.length - offset;
      }
    },
    digest(): string {
      if (finished) throw new Error("SHA-256 is already finished");
      finished = true;
      const bitLength = totalLength * 8;
      // Padding: 0x80, zeros until 56 bytes mod 64, then the 64-bit bit length.
      const paddingLength = blockLength < 56 ? 56 - blockLength : 120 - blockLength;
      const padding = new Uint8Array(paddingLength + 8);
      padding[0] = 0x80;
      const high = Math.floor(bitLength / 0x100000000);
      const low = bitLength >>> 0;
      padding[paddingLength + 0] = (high >>> 24) & 0xff;
      padding[paddingLength + 1] = (high >>> 16) & 0xff;
      padding[paddingLength + 2] = (high >>> 8) & 0xff;
      padding[paddingLength + 3] = high & 0xff;
      padding[paddingLength + 4] = (low >>> 24) & 0xff;
      padding[paddingLength + 5] = (low >>> 16) & 0xff;
      padding[paddingLength + 6] = (low >>> 8) & 0xff;
      padding[paddingLength + 7] = low & 0xff;
      // Feed the padding through the same block path without touching totalLength.
      let offset = 0;
      if (blockLength > 0) {
        const needed = 64 - blockLength;
        const take = Math.min(needed, padding.length);
        block.set(padding.subarray(0, take), blockLength);
        blockLength += take;
        offset = take;
        if (blockLength === 64) {
          processBlock(0);
          blockLength = 0;
        }
      }
      while (padding.length - offset >= 64) {
        block.set(padding.subarray(offset, offset + 64), 0);
        processBlock(0);
        offset += 64;
      }
      if (offset < padding.length) {
        block.set(padding.subarray(offset), 0);
        blockLength = padding.length - offset;
      }
      return state.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
    },
  };
}

/** One-shot SHA-256 hex, for small inputs. */
export function sha256Hex(input: string | Uint8Array): string {
  const digest = createSha256();
  digest.update(typeof input === "string" ? utf8Bytes(input) : input);
  return digest.digest();
}

function rotr32Sha1(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

/**
 * SHA-1 hex, only for the breached-password check: Have I Been Pwned's
 * k-anonymity API takes the first five hex characters, so the full hash —
 * and the password itself — never leaves the device.
 */
export function sha1Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Array<number>(80);
  for (let base = 0; base < paddedLength; base += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(base + i * 4);
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotr32Sha1(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotr32Sha1(a, 5) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = rotr32Sha1(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
}
