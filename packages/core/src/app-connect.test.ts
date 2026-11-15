import type { ConnectionCatalogItem, MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  appConnectCard,
  appConnectedInput,
  connectedAppBlock,
  matchAppCatalog,
} from "./app-connect.js";

const entry: ConnectionCatalogItem = {
  connectorId: "catalog",
  slug: "googlecalendar",
  name: "Google Calendar",
  logo: null,
  connected: false,
  noAuth: false,
};
describe("inline app cards", () => {
  it("reads a card that names no connector as the default the caller gives", () => {
    const { connectorId: _omitted, ...unnamed } = appConnectCard(entry);
    expect(connectedAppBlock(unnamed, "catalog", "gcal", "catalog")).toEqual({
      ...unnamed,
      status: "connected",
    });
    expect(connectedAppBlock(unnamed, "catalog", "gcal", "another")).toBe(unnamed);
  });
  it("matches exact names, slugs, and featured aliases", () => {
    for (const query of ["GOOGLECALENDAR", "Google Calendar", "gcal"])
      expect(matchAppCatalog([entry], query)).toBe(entry);
    expect(matchAppCatalog([entry], "unknown")).toBeUndefined();
  });
  it("builds trusted card fields and preserves unrelated blocks", () => {
    const card = appConnectCard(entry);
    const other = { ...card, connectorId: "other" };
    const text: MessageBlock = { kind: "text", text: "hello" };
    const connected: MessageBlock = { ...card, status: "connected" };
    expect(connectedAppBlock(card, "catalog", "gcal", "first")).toEqual(connected);
    for (const block of [other, text, connected])
      expect(connectedAppBlock(block, "catalog", "gcal", "first")).toBe(block);
    expect(card.description).toBe("Search events and schedule meetings.");
    expect(appConnectedInput("bot", "group-thread", card)).toEqual({
      botId: "bot",
      threadId: "group-thread",
      connectorId: "catalog",
      provider: "googlecalendar",
    });
  });
});
