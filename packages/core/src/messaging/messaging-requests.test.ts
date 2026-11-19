import { expect, it } from "vitest";
import { messagingRequests } from "./messaging-requests.js";

const status = {
  enabled: true,
  providers: ["sendblue"],
  openSignup: false,
  identities: [
    { id: "mi-1", provider: "sendblue", address: "+15550000001", botId: "bot-1", botName: "Chief" },
  ],
};
const channels = [
  {
    id: "cm-1",
    channelId: "ch-1",
    identityId: "mi-1",
    provider: "sendblue",
    name: "Family",
    status: "invited" as const,
    memberCount: 3,
  },
  {
    id: "cm-2",
    channelId: "ch-2",
    identityId: "mi-1",
    provider: "sendblue",
    name: "Ops",
    status: "approved" as const,
    memberCount: 2,
  },
];
const connections = [
  {
    id: "ac-1",
    botId: "bot-1",
    peerBotName: "Assistant",
    peerOwnerLabel: "Dana",
    status: "pending" as const,
    incoming: true,
  },
  {
    id: "ac-2",
    botId: "bot-1",
    peerBotName: "agent",
    peerOwnerLabel: "owner",
    status: "pending" as const,
    incoming: false,
  },
];

it("names the caller's agent on each request waiting for an answer", () => {
  const requests = messagingRequests({ status, channels, connections });
  expect(requests.invites.map(({ channel, agent }) => [channel.id, agent])).toEqual([
    ["cm-1", "Chief"],
  ]);
  expect(
    requests.connectionRequests.map(({ connection, agent }) => [connection.id, agent]),
  ).toEqual([["ac-1", "Chief"]]);
});

it("still lists requests when the agent names could not be read", () => {
  const requests = messagingRequests({ status: undefined, channels, connections });
  expect(requests.invites.map(({ channel, agent }) => [channel.id, agent])).toEqual([
    ["cm-1", undefined],
  ]);
  expect(
    requests.connectionRequests.map(({ connection, agent }) => [connection.id, agent]),
  ).toEqual([["ac-1", undefined]]);
});

it("treats an agent with no name as unknown", () => {
  const unnamed = {
    ...status,
    identities: status.identities.map((identity) => ({ ...identity, botName: "" })),
  };
  const requests = messagingRequests({ status: unnamed, channels, connections });
  expect(requests.invites[0]?.agent).toBeUndefined();
  expect(requests.connectionRequests[0]?.agent).toBeUndefined();
});
