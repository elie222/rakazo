import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { AskReceipt } from "@rakazo/contracts";
import { receiptItems } from "@rakazo/core";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { StyleSheet, Text, View } from "react-native";
import { useMobileTokens } from "../lib/native";

function ReceiptRow({ name, amount, strong }: { name: string; amount: string; strong?: boolean }) {
  const tokens = useMobileTokens();
  const style = {
    color: tokens.foreground,
    ...typeScale.secondary,
    ...(strong ? { fontWeight: fontWeight.medium } : {}),
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 16 }}>
      <Text style={[style, { flexShrink: 1 }]}>{name}</Text>
      <Text style={[style, { marginStart: "auto", fontVariant: ["tabular-nums"] }]}>{amount}</Text>
    </View>
  );
}

/** A payment's order as the page shows it: its lines, then what is paid, then where it came from. */
export function AskReceiptView({ receipt }: { receipt: AskReceipt }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const { button, more, amount, total } = receipt;
  const items = receiptItems(receipt.items, [t`Total`, t`On the button`]);
  const lines = items.length > 0 || Boolean(more) || Boolean(total);
  return (
    <View style={{ marginTop: 10, gap: 10 }}>
      {lines ? (
        <View
          style={{
            gap: 4,
            paddingBottom: 10,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: tokens.border,
          }}
        >
          {items.map((item, index) => (
            // Page lines can repeat, so their place is their key.
            <ReceiptRow key={index} name={item.name} amount={item.amount} />
          ))}
          {more ? (
            <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>
              {t`${ph({ count: `${more.count}${more.atLeast ? "+" : ""}` })} more`}
            </Text>
          ) : null}
          {total ? <ReceiptRow name={t`Total`} amount={total} /> : null}
        </View>
      ) : null}
      {amount ? (
        <ReceiptRow
          strong
          name={receipt.amountSource === "button" ? t`On the button` : t`Total`}
          amount={amount}
        />
      ) : null}
      <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>
        {button
          ? t`Button “${button}” · read from the page, not checked`
          : t`Read from the page, not checked`}
      </Text>
    </View>
  );
}
