import { WAITING_ON_USER_RUN_STATUSES, WORKING_RUN_STATUSES } from "@rakazo/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BOT_AVATAR_COLORS,
  BotAvatar,
  BotShapePreview,
  DEFAULT_BOT_AVATAR_COLOR,
  defaultBotAvatarValue,
  parseBotAvatar,
  resolvePersonaColorDef,
} from "./bot-avatar.js";

describe("BotAvatar", () => {
  it("draws studio shapes with the same face as organic bodies", () => {
    for (const color of ["#8B5CF6::shape_0", "#8B5CF6"]) {
      const html = renderToString(<BotAvatar color={color} status="running" />);
      expect(html).toContain("rakazo-avatar-face");
      expect(html.match(/class="avatar-eye"/g)).toHaveLength(2);
      expect(html).toContain("avatar-cheer");
    }
  });

  // Button sizes any SVG without a size class, which beats width/height attributes but not inline styles.
  it("sizes the shape with an inline style so icon sizing in a button cannot shrink it", () => {
    const html = renderToString(<BotAvatar color="#8B5CF6::shape_0" size={26} />);
    const shape = html.match(/<svg[^>]*rakazo-avatar-face[^>]*>/)?.[0];
    expect(shape).toMatch(/style="[^"]*width:26px;height:26px/);
  });

  it.each([...WORKING_RUN_STATUSES])("marks working run status %s as working", (status) => {
    const html = renderToString(<BotAvatar color="#3B82F6" status={status} />);
    expect(html).toContain("<svg");
    expect(html).toContain('data-working="true"');
  });

  it.each([...WAITING_ON_USER_RUN_STATUSES])(
    "holds still while waiting on the person (%s)",
    (status) => {
      const html = renderToString(<BotAvatar color="#3B82F6" status={status} />);
      expect(html).toContain('data-working="false"');
    },
  );

  it("keeps working attribute false when idle", () => {
    const html = renderToString(<BotAvatar color="#F59E0B" status="idle" />);
    expect(html).toContain('data-working="false"');
  });

  it("renders distinct shapes for distinct bot identities", () => {
    const maya = renderToString(<BotAvatar color={DEFAULT_BOT_AVATAR_COLOR} identity="maya" />);
    const github = renderToString(<BotAvatar color={DEFAULT_BOT_AVATAR_COLOR} identity="github" />);
    expect(maya).not.toEqual(github);
  });

  it("parses shape indexes from encoded color values", () => {
    const parsed = parseBotAvatar(`${DEFAULT_BOT_AVATAR_COLOR}::shape_3`);
    expect(parsed.color).toBe(DEFAULT_BOT_AVATAR_COLOR);
    expect(parsed.shapeIndex).toBe(3);
    expect(parsed.isImage).toBe(false);
  });

  it("normalizes malformed shape suffixes to shape 0", () => {
    expect(parseBotAvatar(`${DEFAULT_BOT_AVATAR_COLOR}::shape_-1`).shapeIndex).toBe(0);
    expect(parseBotAvatar(`${DEFAULT_BOT_AVATAR_COLOR}::shape_3junk`).shapeIndex).toBe(0);
    expect(parseBotAvatar(`${DEFAULT_BOT_AVATAR_COLOR}::shape_`).shapeIndex).toBe(0);
  });

  it("resolves explicit colors and shapes", () => {
    expect(resolvePersonaColorDef("bot", "#10B981").hex).toBe("#00C972");
    expect(resolvePersonaColorDef("bot", "#fff").hex).toBe("#fff");
    expect(BOT_AVATAR_COLORS.length).toBeGreaterThan(0);
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
    expect(html).not.toContain("bot-character-eyes");
  });

  it("draws a working photo as a plain circle that only bounces", () => {
    const html = renderToString(
      <BotAvatar color="data:image/png;base64,abc" identity="maya" size={32} status="running" />,
    );
    expect(html).toContain('class="rakazo-bot-avatar relative shrink-0 select-none"');
    expect(html).toContain("rakazo-bot-avatar-picture");
    expect(html).toContain('data-working="true"');
    expect(html).not.toContain("<svg");
  });

  it("keeps idle photo avatars ring-free", () => {
    const html = renderToString(
      <BotAvatar color="data:image/png;base64,abc" identity="maya" size={32} status="idle" />,
    );
    expect(html).toContain("rakazo-bot-avatar-picture");
    expect(html).toContain('data-working="false"');
    expect(html).not.toContain("rakazo-bot-avatar-ring");
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

  it("restores a plain color that renders the organic body instead of a pinned shape", () => {
    expect(defaultBotAvatarValue(`${DEFAULT_BOT_AVATAR_COLOR}::shape_3`)).toBe(
      DEFAULT_BOT_AVATAR_COLOR,
    );
    expect(defaultBotAvatarValue("#EAB308::shape_1")).toBe("#EAB308");
    expect(defaultBotAvatarValue("#abc::shape_2")).toBe("#abc");
    expect(defaultBotAvatarValue("#fff")).toBe("#fff");
    expect(defaultBotAvatarValue("data:image/png;base64,abc")).toBe(DEFAULT_BOT_AVATAR_COLOR);
    expect(defaultBotAvatarValue("#zzzzzz::shape_1")).toBe(DEFAULT_BOT_AVATAR_COLOR);
    expect(defaultBotAvatarValue("")).toBe(DEFAULT_BOT_AVATAR_COLOR);

    const restored = renderToString(
      <BotAvatar
        color={defaultBotAvatarValue(`${DEFAULT_BOT_AVATAR_COLOR}::shape_4`)}
        identity="maya"
      />,
    );
    const shaped = renderToString(
      <BotAvatar color={`${DEFAULT_BOT_AVATAR_COLOR}::shape_4`} identity="maya" />,
    );
    expect(restored).toContain("rakazo-organic-avatar");
    expect(restored).not.toContain("bot-avatar-container");
    expect(shaped).toContain("bot-avatar-container");
    expect(shaped).not.toContain("rakazo-organic-avatar");
  });

  it("exposes shape picker name and pressed state", () => {
    const html = renderToString(
      <BotShapePreview shapeIndex={0} color="#8B5CF6" selected onClick={() => undefined} />,
    );
    expect(html).toContain('aria-label="hex"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("focus-visible:ring-2");
  });

  it("previews an organic body when no studio shape is given", () => {
    const html = renderToString(
      <BotShapePreview identity="maya" label="Shape 1" color="#8B5CF6" selected={false} />,
    );
    expect(html).toContain('aria-label="Shape 1"');
    expect(html).toContain("rakazo-organic-avatar");
  });

  it("plays the working loop only while working, without morphing the body", () => {
    const idle = renderToString(<BotAvatar color="#8B5CF6" status="idle" />);
    const running = renderToString(<BotAvatar color="#8B5CF6" status="running" />);
    expect(idle).toContain('data-working="false"');
    expect(running).toContain('data-working="true"');
    expect(running).not.toContain("<animate");
  });

  it("draws every plain-colour bot with the organic body", () => {
    const html = renderToString(<BotAvatar color={DEFAULT_BOT_AVATAR_COLOR} identity="maya" />);
    expect(html).toContain("rakazo-organic-avatar");
    expect(html).not.toContain("rakazo-bot-avatar-visor");
  });

  it("keeps uploaded images", () => {
    const html = renderToString(<BotAvatar color="data:image/png;base64,abc" identity="maya" />);
    expect(html).toContain("<img");
    expect(html).not.toContain("rakazo-organic-avatar");
  });

  it("keeps an encoded studio shape", () => {
    const html = renderToString(
      <BotAvatar color={`${DEFAULT_BOT_AVATAR_COLOR}::shape_3`} identity="maya" />,
    );
    expect(html).toContain("bot-avatar-container");
    expect(html).not.toContain("rakazo-organic-avatar");
  });

  it("draws a white bot in the page's ink so it follows the theme", () => {
    const html = renderToString(<BotAvatar color="#FFFFFF" identity="maya" />);
    expect(html).toContain("avatar-body fill-foreground");
    expect(html).not.toContain('fill="#FFFFFF"');
  });

  it("fills the organic body with the resolved palette hex when the custom color is invalid", () => {
    const fallback = resolvePersonaColorDef("maya", "#zzzzzz");
    const html = renderToString(<BotAvatar color="#zzzzzz" identity="maya" />);
    expect(html).toContain("rakazo-organic-avatar");
    expect(html).toContain(`fill="${fallback.hex}"`);
    expect(html).not.toContain("#zzzzzz");
  });
});
