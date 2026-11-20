import { useNativeLinkConfirm } from "@rakazo/chat-ui/native";
import type { LinkButton } from "@rakazo/contracts";
import { View } from "react-native";
import { openExternalUrl } from "../../lib/platform/open-url";
import { NativeActionButton } from "../native/native-action-button";

/** A bot post's link buttons. A web page opens as a chat link does; an app link hands off. */
export function LinkButtons({ buttons }: { buttons: LinkButton[] }) {
  const openLink = useNativeLinkConfirm();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {buttons.map((button, index) => (
        <NativeActionButton
          key={`${index}:${button.url}`}
          label={button.label}
          prominence="secondary"
          size="compact"
          fill={false}
          onPress={() =>
            button.url.startsWith("https:")
              ? openLink(button.url)
              : void openExternalUrl(button.url)
          }
        />
      ))}
    </View>
  );
}
