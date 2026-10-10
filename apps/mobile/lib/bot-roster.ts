import type { MobileBot } from "./api";

export function retainUnchangedBotRoster(current: MobileBot[], next: MobileBot[]): MobileBot[] {
  // The RPC returns full Bot records, including arrays omitted from MobileBot.
  // Compare every field by value while preserving roster and array order.
  const unchanged =
    current.length === next.length &&
    current.every((bot, index) => {
      const candidate = next[index]!;
      const keys = Object.keys(bot) as Array<keyof MobileBot>;
      return (
        keys.length === Object.keys(candidate).length &&
        keys.every((key) => {
          if (!Object.hasOwn(candidate, key)) return false;
          const value = bot[key];
          const nextValue = candidate[key];
          return Array.isArray(value) && Array.isArray(nextValue)
            ? value.length === nextValue.length &&
                value.every((item, index) => item === nextValue[index])
            : value === nextValue;
        })
      );
    });
  return unchanged ? current : next;
}
