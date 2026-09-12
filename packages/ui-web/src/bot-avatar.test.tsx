import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BotAvatar,
  GROK_BOT_COLORS,
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
    expect(gradMatches[0]).toBeTruthy();
    expect(gradMatches[1]).toBeTruthy();
    expect(gradMatches[0]).not.toBe(gradMatches[1]);
    expect(html).toContain(`url(#${gradMatches[0]})`);
    expect(html).toContain(`url(#${gradMatches[1]})`);
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

  it("renders a geometric mascot for plain color values", () => {
    const html = renderToString(
      <BotAvatar color="#D9508A" identity="maya" size={28} status="running" />,
    );
    expect(html).toContain("<svg");
    expect(html).toContain("<path");
    expect(html).toContain("<ellipse");
    expect(html).toContain('data-working="true"');
  });

  it("renders distinct shapes for distinct bot identities", () => {
    const maya = renderToString(<BotAvatar color="#D9508A" identity="maya" />);
    const github = renderToString(<BotAvatar color="#D9508A" identity="github" />);
    expect(maya).not.toEqual(github);
  });

  it("parses shape indexes from encoded color values", () => {
    const parsed = parseBotAvatar("#8B5CF6::shape_3");
    expect(parsed.color).toBe("#8B5CF6");
    expect(parsed.shapeIndex).toBe(3);
    expect(parsed.isImage).toBe(false);
  });

  it("resolves explicit colors and shapes", () => {
    expect(resolvePersonaColorDef("bot", "#10B981").hex.toLowerCase()).toBe("#10b981");
    expect(resolvePersonaShape("bot", "hex")).toContain("M");
    expect(GROK_BOT_COLORS.length).toBeGreaterThan(0);
  });

  it("renders uploaded images without the geometric svg", () => {
    const html = renderToString(
      <BotAvatar color="data:image/png;base64,abc" identity="maya" size={32} />,
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("<svg");
  });
});
