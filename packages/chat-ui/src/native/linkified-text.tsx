import type { ColorTokens } from "@rakazo/ui-tokens";
import { typeScale } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { Fragment, memo } from "react";
import type { TextStyle } from "react-native";
import { Text } from "react-native";
import { linkFaviconOrigin, linkLabel, plainTextLinkParts } from "../markdown";
import { MarkdownPageChip } from "./chips";
import { contraryDirection } from "./direction";
import { ISOLATE, LinkFavicon, POP_ISOLATE, useNativeLinkConfirm, WORD_JOINER } from "./links";
import { layout } from "./styles";

type LinkifiedTextProps = {
  children: string;
  color: string;
  linkColor: string;
  palette: ColorTokens;
  /** Renders the runs between links (and where each starts in the text); plain strings by default. */
  renderText?: (text: string, start: number) => ReactNode;
  onOpenPage?: (pageId: string) => void;
};

export const LinkifiedText = memo(function LinkifiedText({
  children,
  color,
  linkColor,
  palette,
  renderText,
  onOpenPage,
}: LinkifiedTextProps) {
  const openLink = useNativeLinkConfirm();
  const labelStyle: TextStyle = {
    color,
    fontWeight: "500",
    textDecorationLine: "underline",
    // Links in a bubble are the bubble's text colour, so the underline is what marks them.
    textDecorationColor: linkColor,
  };
  return (
    <Text style={[{ color, ...typeScale.body }, contraryDirection(children) && layout.farSideText]}>
      {plainTextLinkParts(children).map((part, index) => {
        if (part.type === "text") {
          return renderText ? (
            <Fragment key={index}>{renderText(part.value, part.start)}</Fragment>
          ) : (
            part.value
          );
        }
        if (part.type === "page") {
          return (
            <MarkdownPageChip
              key={index}
              pageId={part.pageId}
              titleStyle={{ textDecorationLine: "underline", textDecorationColor: linkColor }}
              onOpenPage={onOpenPage}
            >
              {part.value}
            </MarkdownPageChip>
          );
        }
        const open = () => {
          openLink(part.href);
        };
        if (!linkFaviconOrigin(part.href)) {
          return (
            <Text
              accessibilityRole="link"
              key={index}
              style={{ color: linkColor, textDecorationLine: "underline" }}
              onPress={open}
            >
              {part.value}
            </Text>
          );
        }
        const label = linkLabel(part.value, part.href);
        return (
          <Text
            accessibilityRole="link"
            accessibilityLabel={label}
            key={index}
            style={{ color, fontWeight: "500" }}
            onPress={open}
          >
            <LinkFavicon
              href={part.href}
              plate={{ backgroundColor: palette.faviconPlate, padding: 2 }}
            />
            {WORD_JOINER}
            {ISOLATE}
            <Text style={labelStyle}>{label}</Text>
            {POP_ISOLATE}
          </Text>
        );
      })}
    </Text>
  );
});
