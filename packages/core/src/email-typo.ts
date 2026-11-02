const KNOWN_DOMAINS = [
  "gmail.com",
  "icloud.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "163.com",
  "126.com",
  "live.com",
  "me.com",
  "msn.com",
  "aol.com",
  "googlemail.com",
  "foxmail.com",
  "ymail.com",
  "gmx.com",
  "mail.com",
  "email.com",
];

const COM_TYPOS = new Set([
  "con",
  "cmo",
  "ocm",
  "vom",
  "xom",
  "dom",
  "cpm",
  "comm",
  "coom",
  "come",
]);

/** Optimal string alignment distance: edits plus adjacent swaps. */
function editDistance(a: string, b: string): number {
  const width = b.length + 1;
  const cells = new Array<number>((a.length + 1) * width).fill(0);
  const at = (i: number, j: number) => cells[i * width + j] ?? 0;
  for (let i = 0; i <= a.length; i++) {
    for (let j = 0; j <= b.length; j++) {
      let value = Math.max(i, j);
      if (i > 0 && j > 0) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        value = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          value = Math.min(value, at(i - 2, j - 2) + 1);
        }
      }
      cells[i * width + j] = value;
    }
  }
  return at(a.length, b.length);
}

function correctedDomain(domain: string): string | null {
  if (KNOWN_DOMAINS.includes(domain)) return null;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const known of KNOWN_DOMAINS) {
    const distance = editDistance(domain, known);
    // Short domains are close to each other (126.com vs 163.com), so they only allow one edit.
    if (distance <= (known.length >= 9 ? 2 : 1) && distance < bestDistance) {
      best = known;
      bestDistance = distance;
    }
  }
  if (best) return best;
  const dot = domain.lastIndexOf(".");
  if (dot > 0 && COM_TYPOS.has(domain.slice(dot + 1))) return `${domain.slice(0, dot)}.com`;
  return null;
}

/** A likely intended address when the domain looks mistyped, e.g. `a@gmial.com` → `a@gmail.com`. */
export function suggestEmailCorrection(email: string): string | null {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at < 1) return null;
  const domain = correctedDomain(trimmed.slice(at + 1).toLowerCase());
  return domain ? `${trimmed.slice(0, at + 1)}${domain}` : null;
}
