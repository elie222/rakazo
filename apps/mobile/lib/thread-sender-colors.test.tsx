import { readFileSync } from "node:fs";
import { resolvePersonaColorDef } from "@rakazo/core";
import { botColors, darkTokens, fontWeight, typeScale } from "@rakazo/ui-tokens";
import React, { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { expect, it } from "vitest";
import { messagePresentationSegments } from "./message-presentation";

const source = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
const helpers = source.slice(
  source.indexOf("function memberName("),
  source.indexOf("type MessageActionProps"),
);
const cards = source.slice(
  source.indexOf("const MessageBubble = memo(function MessageBubble({"),
  source.indexOf("function AgentEventLabel("),
);
const scope = {
  React,
  useState,
  memo: <T,>(component: T) => component,
  useResolvedAppearance: () => "dark",
  mobileTokens: () => darkTokens,
  useI18n: () => ({ t: (text: string) => text }),
  resolvePersonaColorDef,
  messagePresentationSegments,
  blockText: () => "Hello",
  MessageCaption: () => null,
  formatFileSize: () => undefined,
  View: "div",
  Text: "span",
  Pressable: "button",
  typeScale,
  fontWeight,
};
const MessageBubble = new Function(
  ...Object.keys(scope),
  ts.transpileModule(`${helpers}\n${cards}\nreturn MessageBubble;`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText,
)(...Object.values(scope));

function contrastRatio(text: string, surface: string): number {
  const luminance = (hex: string) =>
    [1, 3, 5].reduce((sum, offset, i) => {
      const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return (
        sum +
        [0.2126, 0.7152, 0.0722][i]! * (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      );
    }, 0);
  return (luminance(text) + 0.05) / (luminance(surface) + 0.05);
}

it.each(["text", "image"] as const)("keeps per-bot sender colours on %s messages", (kind) => {
  for (const [index, color] of botColors.entries()) {
    const id = `bot-${index}`;
    const html = renderToStaticMarkup(
      <MessageBubble
        botId={id}
        groupId="group"
        bots={[{ id, color }]}
        members={[{ botId: id, name: "Sender" }]}
        message={{
          id: "message",
          role: "bot",
          botId: id,
          blocks: [kind === "text" ? { kind, text: "Hello" } : { kind, name: "Picture" }],
        }}
        actionProps={{}}
      />,
    );
    const senderColor = resolvePersonaColorDef(id, color).light;
    expect(html).toContain(`color:${senderColor}`);
    for (const surface of [darkTokens.muted, darkTokens.background]) {
      expect(contrastRatio(senderColor, surface)).toBeGreaterThanOrEqual(3);
    }
    expect(html).toContain(">Sender</span>");
  }
});
