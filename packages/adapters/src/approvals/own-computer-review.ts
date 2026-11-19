import { sitesInText } from "@rakazo/core/egress";

/**
 * A longer command reaches the reviewer as its start and end, which hold what it runs and usually
 * where it sends, plus every address named in the part left out, so a cut never hides where data
 * goes. The bound keeps the review fast and under the reviewer's argument limit.
 */
export const MAX_REVIEW_COMMAND_CHARS = 4_000;
const COMMAND_HEAD_CHARS = 2_800;
const COMMAND_TAIL_CHARS = 1_000;
const MAX_LEFT_OUT_ADDRESSES = 20;
const MAX_ADDRESS_CHARS = 200;

/** Shell words split here; `=` too, so `--url=https://…` yields the URL and a query keeps its host. */
const WORD_SEPARATORS = /[\s<>"'`|;&()=,]+/;
const URL_WORD = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Mail, ssh, scp and git name a host after `@`. */
const USER_AT_HOST_WORD = /^[^@]+@[^@]+$/;
const IPV4_WORD = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/;
const MAX_HOST_CHARS = 253;

/**
 * The addresses a piece of a command names: URLs of any scheme, `user@host`, IPv4 addresses and
 * bare host names on a known suffix (`nc collect.example.net 443`, `dig`). Read one word at a time
 * with anchored patterns, so a long command is read in linear time; each is cut short enough to
 * keep its host.
 */
function addressesIn(text: string): string[] {
  const found = new Set<string>();
  for (const word of text.split(WORD_SEPARATORS)) {
    if (found.size >= MAX_LEFT_OUT_ADDRESSES) break;
    if (URL_WORD.test(word) || USER_AT_HOST_WORD.test(word)) found.add(word);
    else if (IPV4_WORD.test(word)) found.add(IPV4_WORD.exec(word)![0]);
    else {
      // `$(…).sink.example.net` leaves a word that starts with a dot.
      const host = word.replace(/^\.+/, "");
      if (host.includes(".") && host.length <= MAX_HOST_CHARS && sitesInText(host).size)
        found.add(host);
    }
  }
  return [...found]
    .slice(0, MAX_LEFT_OUT_ADDRESSES)
    .map((address) =>
      address.length <= MAX_ADDRESS_CHARS ? address : `${address.slice(0, MAX_ADDRESS_CHARS)}…`,
    );
}

/**
 * What Auto Review sees of a call on the bot's own computer, from arguments already redacted for
 * review: a browser action also names the page it acts on (`pageUrl`, the browser's own report),
 * since the refs it presses mean nothing without it.
 */
export function ownComputerReviewArgs(
  toolName: string,
  args: Record<string, unknown>,
  pageUrl: string | undefined,
): Record<string, unknown> {
  if (toolName === "browser_act") {
    const page = pageUrl && URL.canParse(pageUrl) ? new URL(pageUrl).origin : undefined;
    return page && page !== "null" ? { ...args, page } : args;
  }
  if (toolName !== "shell" || typeof args.command !== "string") return args;
  const command = args.command;
  if (command.length <= MAX_REVIEW_COMMAND_CHARS) return args;
  const leftOut = command.slice(COMMAND_HEAD_CHARS, command.length - COMMAND_TAIL_CHARS);
  // Read past both cuts, so an address split by one still shows its host.
  const addresses = addressesIn(
    command.slice(
      COMMAND_HEAD_CHARS - MAX_ADDRESS_CHARS,
      command.length - COMMAND_TAIL_CHARS + MAX_ADDRESS_CHARS,
    ),
  );
  return {
    ...args,
    command: `${command.slice(0, COMMAND_HEAD_CHARS)}\n…[${leftOut.length} characters left out]…\n${command.slice(-COMMAND_TAIL_CHARS)}`,
    ...(addresses.length ? { addressesInPartLeftOut: addresses } : {}),
  };
}
