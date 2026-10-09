import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AvatarStyleProvider } from "./avatar-style.js";
import {
  BotAvatar,
  DEFAULT_GROK_BOT_COLOR,
  defaultBotAvatarValue,
  GROK_BOT_COLORS,
  GrokShapePreview,
  parseBotAvatar,
  resolvePersonaColorDef,
  resolvePersonaShape,
} from "./bot-avatar.js";

describe("BotAvatar", () => {
  it("renders distinct SVG gradient IDs for concurrent working avatars", () => {
    const html = renderToString(
      <div>
        <BotAvatar color="#8B5CF6" status="running" />
        <BotAvatar color="#10B981" status="running" />
      </div>,
    );

    const gradMatches = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(gradMatches).toHaveLength(2);
    expect(new Set(gradMatches).size).toBe(2);
    for (const id of gradMatches) {
      expect(id).toBeTruthy();
      expect(html).toContain(`url(#${id})`);
    }
  });

  it.each([...ACTIVE_RUN_STATUSES])("marks active run status %s as working", (status) => {
    const html = renderToString(<BotAvatar color="#3B82F6" status={status} />);
    expect(html).toContain("<svg");
    expect(html).toContain('data-working="true"');
  });

  it("keeps working attribute false when idle", () => {
    const html = renderToString(<BotAvatar color="#F59E0B" status="idle" />);
    expect(html).toContain('data-working="false"');
  });

  it("fits the robot eyes inside the visor at every rendered size", () => {
    for (const size of [14, 15, 16, 18, 20, 21, 22, 25, 26, 28, 32, 38, 72, 76, 78, 120]) {
      const html = renderToString(
        <BotAvatar color={DEFAULT_GROK_BOT_COLOR} identity="maya" size={size} />,
      );
      const face = robotFaceFromHtml(html);
      expect(face.eyeW * 2 + face.eyeGap).toBeLessThanOrEqual(face.innerW);
      expect(face.eyeH).toBeLessThanOrEqual(face.innerH);
      expect(face.eyeW).toBeGreaterThan(0);
      expect(face.eyeH).toBeGreaterThan(0);
    }
  });

  it("keeps the robot face proportions from 28px up", () => {
    const face = robotFaceFromHtml(
      renderToString(<BotAvatar color={DEFAULT_GROK_BOT_COLOR} identity="maya" size={28} />),
    );
    expect(face.visorW).toBe(19);
    expect(face.visorH).toBe(12);
    expect(face.eyeW).toBe(4);
    expect(face.eyeH).toBe(7);
    expect(face.eyeGap).toBe(3);
  });

  it("renders the animated robot face for plain color values", () => {
    const html = renderToString(
      <BotAvatar color={DEFAULT_GROK_BOT_COLOR} identity="maya" size={28} status="running" />,
    );
    expect(html).toContain("rakazo-bot-avatar-visor");
    expect(html).toContain("rakazo-bot-avatar-eyes");
    expect(html).toContain("rakazo-eyes-idle-");
    expect(html).not.toContain("<ellipse");
    expect(html).toContain('data-working="true"');
  });

  it("renders distinct shapes for distinct bot identities", () => {
    const maya = renderToString(<BotAvatar color={DEFAULT_GROK_BOT_COLOR} identity="maya" />);
    const github = renderToString(<BotAvatar color={DEFAULT_GROK_BOT_COLOR} identity="github" />);
    expect(maya).not.toEqual(github);
  });

  it("parses shape indexes from encoded color values", () => {
    const parsed = parseBotAvatar(`${DEFAULT_GROK_BOT_COLOR}::shape_3`);
    expect(parsed.color).toBe(DEFAULT_GROK_BOT_COLOR);
    expect(parsed.shapeIndex).toBe(3);
    expect(parsed.isImage).toBe(false);
  });

  it("normalizes malformed shape suffixes to shape 0", () => {
    expect(parseBotAvatar(`${DEFAULT_GROK_BOT_COLOR}::shape_-1`).shapeIndex).toBe(0);
    expect(parseBotAvatar(`${DEFAULT_GROK_BOT_COLOR}::shape_3junk`).shapeIndex).toBe(0);
    expect(parseBotAvatar(`${DEFAULT_GROK_BOT_COLOR}::shape_`).shapeIndex).toBe(0);
  });

  it("exposes the violet identity color as the shared default", () => {
    expect(GROK_BOT_COLORS).toContain(DEFAULT_GROK_BOT_COLOR);
    expect(parseBotAvatar(`${DEFAULT_GROK_BOT_COLOR}::shape_0`).color).toBe(DEFAULT_GROK_BOT_COLOR);
  });

  it("resolves explicit colors and shapes", () => {
    expect(resolvePersonaColorDef("bot", "#10B981").hex.toLowerCase()).toBe("#10b981");
    expect(resolvePersonaColorDef("bot", "#fff").hex).toBe("#fff");
    expect(resolvePersonaShape("bot", "hex")).toContain("M");
    expect(GROK_BOT_COLORS.length).toBeGreaterThan(0);
  });

  it("falls back to the identity palette for invalid custom hex", () => {
    expect(resolvePersonaColorDef("bot", "#zzzzzz")).toEqual(resolvePersonaColorDef("bot"));
    expect(resolvePersonaColorDef("bot", "#ggg")).toEqual(resolvePersonaColorDef("bot"));
  });

  it("renders uploaded images without the geometric svg", () => {
    const html = renderToString(
      <BotAvatar color="data:image/png;base64,abc" identity="maya" size={32} />,
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("<path");
    expect(html).not.toContain("grok-character-eyes");
  });

  it("does not treat arbitrary http(s) color values as remote images", () => {
    const parsed = parseBotAvatar("https://evil.example/track.png");
    expect(parsed.isImage).toBe(false);
    expect(parsed.imageUrl).toBeUndefined();
    const html = renderToString(
      <BotAvatar color="https://evil.example/track.png" identity="maya" size={32} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
  });

  it("honors reduced-motion for the working mascot pulse class", () => {
    const html = renderToString(
      <BotAvatar color="#8B5CF6::shape_0" identity="maya" size={32} status="running" />,
    );
    expect(html).toContain("animate-pulse");
    expect(html).toContain("motion-reduce:animate-none");
  });

  it("restores a plain color that renders the animated robot instead of a pinned shape", () => {
    expect(defaultBotAvatarValue(`${DEFAULT_GROK_BOT_COLOR}::shape_3`)).toBe(
      DEFAULT_GROK_BOT_COLOR,
    );
    expect(defaultBotAvatarValue("#EAB308::shape_1")).toBe("#EAB308");
    expect(defaultBotAvatarValue("#abc::shape_2")).toBe("#abc");
    expect(defaultBotAvatarValue("#fff")).toBe("#fff");
    expect(defaultBotAvatarValue("data:image/png;base64,abc")).toBe(DEFAULT_GROK_BOT_COLOR);
    expect(defaultBotAvatarValue("#zzzzzz::shape_1")).toBe(DEFAULT_GROK_BOT_COLOR);
    expect(defaultBotAvatarValue("")).toBe(DEFAULT_GROK_BOT_COLOR);

    const restored = renderToString(
      <BotAvatar
        color={defaultBotAvatarValue(`${DEFAULT_GROK_BOT_COLOR}::shape_4`)}
        identity="maya"
      />,
    );
    const shaped = renderToString(
      <BotAvatar color={`${DEFAULT_GROK_BOT_COLOR}::shape_4`} identity="maya" />,
    );
    expect(restored).toContain("rakazo-bot-avatar-visor");
    expect(restored).not.toContain("grok-character-eyes");
    expect(shaped).toContain("grok-character-eyes");
    expect(shaped).not.toContain("rakazo-bot-avatar-visor");
  });

  it("exposes shape picker name and pressed state", () => {
    const html = renderToString(
      <GrokShapePreview shapeIndex={0} color="#8B5CF6" selected onClick={() => undefined} />,
    );
    expect(html).toContain('aria-label="hex"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("focus-visible:ring-2");
  });

  it("renders distinct robot and organic previews for the same identity", () => {
    const robot = renderToString(
      <BotAvatar color={DEFAULT_GROK_BOT_COLOR} identity="avatar-style-preview" variant="robot" />,
    );
    const organic = renderToString(
      <BotAvatar
        color={DEFAULT_GROK_BOT_COLOR}
        identity="avatar-style-preview"
        variant="organic"
      />,
    );
    expect(robot).not.toEqual(organic);
    expect(robot).toContain("rakazo-bot-avatar-eyes");
    expect(robot).not.toContain("grok-character-eyes");
    expect(organic).toContain("rakazo-organic-avatar");
    expect(organic).not.toContain("rakazo-bot-avatar-eyes");
  });

  it("uses the preferred avatar style when variant is omitted", () => {
    const html = renderToString(
      <AvatarStyleProvider value="organic">
        <BotAvatar color={DEFAULT_GROK_BOT_COLOR} identity="maya" />
      </AvatarStyleProvider>,
    );
    expect(html).toContain("rakazo-organic-avatar");
    expect(html).not.toContain("grok-character-eyes");
  });

  it("keeps uploaded images when the organic style is preferred", () => {
    const html = renderToString(
      <BotAvatar color="data:image/png;base64,abc" identity="maya" variant="organic" />,
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("rakazo-organic-avatar");
  });

  it("keeps an encoded studio shape when the organic style is preferred", () => {
    const html = renderToString(
      <BotAvatar color={`${DEFAULT_GROK_BOT_COLOR}::shape_3`} identity="maya" variant="organic" />,
    );
    expect(html).toContain("grok-character-eyes");
    expect(html).not.toContain("rakazo-organic-avatar");
  });

  it("fills the organic body with the resolved palette hex when the custom color is invalid", () => {
    const fallback = resolvePersonaColorDef("maya", "#zzzzzz");
    const html = renderToString(<BotAvatar color="#zzzzzz" identity="maya" variant="organic" />);
    expect(html).toContain("rakazo-organic-avatar");
    expect(html).toContain(`fill="${fallback.hex}"`);
    expect(html).not.toContain("#zzzzzz");
  });
});

function styleValue(style: string, property: string): string {
  const match = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
  const value = match?.[1]?.trim();
  if (!value) throw new Error(`missing ${property} in ${style}`);
  return value;
}

function px(style: string, property: string): number {
  const value = styleValue(style, property);
  const match = value.match(/^(\d+)px$/);
  if (!match?.[1]) throw new Error(`${property} is not px: ${value}`);
  return Number(match[1]);
}

function robotFaceFromHtml(html: string) {
  const visor = html.match(/class="[^"]*rakazo-bot-avatar-visor[^"]*" style="([^"]*)"/);
  const visorStyle = visor?.[1];
  if (!visorStyle) throw new Error("missing visor");
  const border = styleValue(visorStyle, "border").match(/^(\d+)px/);
  const borderPx = Number(border?.[1] ?? "0");
  const eyeRows = [...html.matchAll(/class="[^"]*rakazo-bot-avatar-eyes[^"]*" style="([^"]*)"/g)];
  const eyeSpans = [...html.matchAll(/<span class="block" style="([^"]*background-color:[^"]*)"/g)];
  if (eyeRows.length === 0 || eyeSpans.length === 0) throw new Error("missing eyes");
  const gaps = eyeRows.map((row) => px(row[1] ?? "", "gap"));
  const widths = eyeSpans.map((span) => px(span[1] ?? "", "width"));
  const heights = eyeSpans.map((span) => px(span[1] ?? "", "height"));
  const eyeGap = gaps[0];
  const eyeW = widths[0];
  const eyeH = heights[0];
  if (eyeGap === undefined || eyeW === undefined || eyeH === undefined) {
    throw new Error("missing eye metrics");
  }
  expect(new Set(gaps)).toEqual(new Set([eyeGap]));
  expect(new Set(widths)).toEqual(new Set([eyeW]));
  expect(new Set(heights)).toEqual(new Set([eyeH]));
  return {
    visorW: px(visorStyle, "width"),
    visorH: px(visorStyle, "height"),
    innerW: px(visorStyle, "width") - borderPx * 2,
    innerH: px(visorStyle, "height") - borderPx * 2,
    eyeW,
    eyeH,
    eyeGap,
  };
}
