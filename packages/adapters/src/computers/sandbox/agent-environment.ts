import { redactSecrets } from "@rakazo/core";

export function redactShellStreams(
  snapshot: { stdout: string; stderr: string },
  secrets: string[],
  options?: { withholdPartial?: boolean },
): { stdout: string; stderr: string } {
  let stdout = redactSecrets(snapshot.stdout, secrets);
  let stderr = redactSecrets(snapshot.stderr, secrets);
  const values = secrets.filter((secret) => secret.length > 0);
  for (let pass = 0; pass < values.length; pass++) {
    let changed = false;
    for (const secret of values) {
      const next = redactSpanningSecret(stdout, stderr, secret);
      if (next.stdout !== stdout || next.stderr !== stderr) {
        stdout = next.stdout;
        stderr = next.stderr;
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (!options?.withholdPartial) return { stdout, stderr };
  return withholdSecretPrefix(stdout, stderr, values);
}

export function redactAgentCommandResult(
  result: { stdout: string; stderr: string; code: number },
  secrets: string[],
) {
  return { ...result, ...redactShellStreams(result, secrets) };
}

function redactSpanningSecret(
  stdout: string,
  stderr: string,
  secret: string,
): { stdout: string; stderr: string } {
  if (secret.length < 2 || stdout.length === 0 || stderr.length === 0) return { stdout, stderr };
  const headLen = Math.min(secret.length - 1, stdout.length);
  const tailLen = Math.min(secret.length - 1, stderr.length);
  const head = stdout.slice(stdout.length - headLen);
  const boundary = head + stderr.slice(0, tailLen);
  const index = boundary.indexOf(secret);
  if (index < 0) return { stdout, stderr };
  const start = stdout.length - headLen + index;
  const end = start + secret.length;
  if (start >= stdout.length || end <= stdout.length) return { stdout, stderr };
  return {
    stdout: `${stdout.slice(0, start)}[redacted]`,
    stderr: stderr.slice(end - stdout.length),
  };
}

/**
 * Longest suffix of `text` that is a proper prefix of `secret`, in O(min(text.length, secret.length)) time.
 */
export function secretPrefixSuffixLength(text: string, secret: string): number {
  const maxLen = Math.min(text.length, secret.length - 1);
  if (maxLen <= 0) return 0;
  const firstChar = secret.charCodeAt(0);
  const scanStart = text.length - maxLen;
  let start = -1;
  for (let i = scanStart; i < text.length; i += 1) {
    if (text.charCodeAt(i) === firstChar) {
      start = i;
      break;
    }
  }
  if (start < 0) return 0;
  const patLen = text.length - start;
  if (patLen === 1) return 1;
  const lps = new Int32Array(patLen);
  for (let i = 1, j = 0; i < patLen; i += 1) {
    const ch = secret.charCodeAt(i);
    while (j > 0 && secret.charCodeAt(j) !== ch) j = lps[j - 1]!;
    if (secret.charCodeAt(j) === ch) j += 1;
    lps[i] = j;
  }
  let matched = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    while (matched > 0 && secret.charCodeAt(matched) !== ch) matched = lps[matched - 1]!;
    if (secret.charCodeAt(matched) === ch) matched += 1;
  }
  return matched;
}

/**
 * Longest prefix of `text` that is a proper suffix of `secret`, in O(min(text.length, secret.length)) time.
 */
export function secretSuffixPrefixLength(text: string, secret: string): number {
  const last = secret.length - 1;
  const maxLen = Math.min(text.length, last);
  if (maxLen <= 0) return 0;
  const lastChar = secret.charCodeAt(last);
  let end = -1;
  for (let i = maxLen - 1; i >= 0; i -= 1) {
    if (text.charCodeAt(i) === lastChar) {
      end = i;
      break;
    }
  }
  if (end < 0) return 0;
  const patLen = end + 1;
  if (patLen === 1) return 1;
  const lps = new Int32Array(patLen);
  for (let i = 1, j = 0; i < patLen; i += 1) {
    const ch = secret.charCodeAt(last - i);
    while (j > 0 && secret.charCodeAt(last - j) !== ch) j = lps[j - 1]!;
    if (secret.charCodeAt(last - j) === ch) j += 1;
    lps[i] = j;
  }
  let matched = 0;
  for (let i = end; i >= 0; i -= 1) {
    const ch = text.charCodeAt(i);
    while (matched > 0 && secret.charCodeAt(last - matched) !== ch) matched = lps[matched - 1]!;
    if (secret.charCodeAt(last - matched) === ch) matched += 1;
  }
  return matched;
}

/** How far `text` continues `secret` from `offset`, in UTF-16 code units. */
function secretContinuationLength(text: string, secret: string, offset: number): number {
  const limit = Math.min(text.length, secret.length - offset);
  let size = 0;
  while (size < limit && text.charCodeAt(size) === secret.charCodeAt(offset + size)) size += 1;
  return size;
}

function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function publishWithheld(text: string, holdStart: number, holdEnd: number): string {
  if (holdStart <= 0 && holdEnd <= 0) return text;
  let start = Math.max(holdStart, 0);
  let end = holdEnd > 0 ? text.length - holdEnd : text.length;
  // Keep a surrogate pair out of the published view rather than splitting it.
  if (splitsSurrogatePair(text, start)) start += 1;
  if (splitsSurrogatePair(text, end)) end -= 1;
  if (end <= start) return "";
  return text.slice(start, end);
}

function withholdSecretPrefix(
  stdout: string,
  stderr: string,
  secrets: string[],
): { stdout: string; stderr: string } {
  let stdoutHold = 0;
  let stderrHoldEnd = 0;
  let stderrHoldStart = 0;
  for (const secret of secrets) {
    if (secret.length < 2) continue;
    const stdoutPrefix = secretPrefixSuffixLength(stdout, secret);
    stdoutHold = Math.max(stdoutHold, stdoutPrefix);
    stderrHoldEnd = Math.max(stderrHoldEnd, secretPrefixSuffixLength(stderr, secret));
    // The live view joins the streams. A prefix that ends stdout and continues into
    // stderr is one secret fragment: holding only the stdout piece would publish the rest.
    if (stdoutPrefix > 0) {
      stderrHoldStart = Math.max(
        stderrHoldStart,
        secretContinuationLength(stderr, secret, stdoutPrefix),
      );
    }
  }
  return {
    stdout: publishWithheld(stdout, 0, stdoutHold),
    stderr: publishWithheld(stderr, stderrHoldStart, stderrHoldEnd),
  };
}
