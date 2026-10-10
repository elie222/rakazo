import type { MobileBot } from "./api";

export function retainUnchangedBotRoster(current: MobileBot[], next: MobileBot[]): MobileBot[] {
  // MobileBot is a flat RPC record of scalar fields. Preserve order and compare
  // every field, including optional ones, without serializing the roster.
  const unchanged =
    current.length === next.length &&
    current.every((bot, index) => {
      const candidate = next[index]!;
      const keys = Object.keys(bot) as Array<keyof MobileBot>;
      return (
        keys.length === Object.keys(candidate).length &&
        keys.every((key) => Object.hasOwn(candidate, key) && bot[key] === candidate[key])
      );
    });
  return unchanged ? current : next;
}
