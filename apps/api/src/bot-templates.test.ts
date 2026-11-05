import type { ConnectionCatalogItem } from "@rakazo/contracts";
import { findBotTemplate } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { templateAppCards } from "./bot-templates.js";

const entry = (connectorId: string, slug: string, name: string, connected: boolean) =>
  ({ connectorId, slug, name, logo: null, connected, noAuth: false }) as ConnectionCatalogItem;

describe("templateAppCards", () => {
  const briefing = findBotTemplate("morning-briefing")!;

  it("asks only for apps no provider has connected, and skips apps the server lacks", () => {
    const cards = templateAppCards(briefing, [
      // One provider lists Gmail as not connected before another that has it connected.
      entry("first", "gmail", "Gmail", false),
      entry("second", "gmail", "Gmail", true),
      entry("first", "googlecalendar", "Google Calendar", false),
    ]);
    expect(cards).toEqual([
      expect.objectContaining({ kind: "app_connect", name: "Google Calendar", status: "pending" }),
    ]);
    expect(templateAppCards(briefing, [])).toEqual([]);
  });
});
