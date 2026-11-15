import { ORPCError, onError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import {
  ComputerBusyError,
  ComputerSpaceDeletingError,
  WorkspacePathError,
} from "@rakazo/adapters";
import { ClientError } from "@rakazo/core";
import {
  BotSectionNameConflictError,
  CannotDeleteDefaultSpaceError,
  CannotDeleteLastOrganizationError,
  CannotDeleteLastSpaceError,
  CannotDeleteSpaceAsNonOwnerError,
  CannotRemoveSpaceOwnerError,
  CannotRenameSpaceAsNonOwnerError,
  ComputerLimitError,
  InstructionConflictError,
  InvalidSpaceNameError,
  OrganizationLimitError,
  SharedOrganizationError,
  SpaceDeletionInProgressError,
  SpaceInviteLimitError,
  SpaceInviteNotFoundError,
  SpaceLimitError,
  SpaceMemberNotFoundError,
  SpaceNotFoundError,
  SpaceOwnerCannotLeaveError,
  SpaceOwnerRequiredError,
} from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactListCursorError } from "./artifacts.js";
import { NameTakenError } from "./availability.js";
import { PageListCursorError, PageShareConflictError } from "./pages.js";
import { handleRpcError } from "./rpc-errors.js";

/** Each domain refusal with the answer its routes wrote by hand before the central mapping. */
const REFUSALS: Array<[error: Error, code: string, status: number, message: string]> = [
  [new SpaceLimitError(), "BAD_REQUEST", 400, "Space limit reached"],
  [
    new InvalidSpaceNameError(),
    "BAD_REQUEST",
    400,
    "Space name must be readable and between 1 and 60 characters",
  ],
  [new SpaceNotFoundError(), "NOT_FOUND", 404, "Space not found"],
  [new CannotDeleteDefaultSpaceError(), "BAD_REQUEST", 400, "The default space cannot be deleted"],
  [
    new CannotDeleteLastSpaceError(),
    "BAD_REQUEST",
    400,
    "The last remaining space cannot be deleted",
  ],
  [new CannotDeleteSpaceAsNonOwnerError(), "FORBIDDEN", 403, "Only the space owner can delete it"],
  [new CannotRenameSpaceAsNonOwnerError(), "FORBIDDEN", 403, "Only the space owner can rename it"],
  [new SpaceDeletionInProgressError(), "CONFLICT", 409, "Space deletion is already in progress"],
  [new OrganizationLimitError(), "BAD_REQUEST", 400, "You can have up to 10 organizations."],
  [
    new CannotDeleteLastOrganizationError(),
    "BAD_REQUEST",
    400,
    "Your only organization cannot be deleted",
  ],
  [
    new SharedOrganizationError(),
    "BAD_REQUEST",
    400,
    "An organization with other members cannot be deleted",
  ],
  [
    new SpaceInviteLimitError(),
    "BAD_REQUEST",
    400,
    "Too many open invite links; wait for some to be used or expire",
  ],
  [new SpaceOwnerRequiredError(), "FORBIDDEN", 403, "Only the space owner can do that"],
  [new SpaceInviteNotFoundError(), "NOT_FOUND", 404, "This invite link is invalid or has expired"],
  [new SpaceMemberNotFoundError(), "NOT_FOUND", 404, "Member not found"],
  [new CannotRemoveSpaceOwnerError(), "BAD_REQUEST", 400, "The space owner cannot be removed"],
  [
    new SpaceOwnerCannotLeaveError(),
    "BAD_REQUEST",
    400,
    "The space owner cannot leave; delete the space instead",
  ],
  [new ComputerLimitError(3), "BAD_REQUEST", 400, "User computer limit (3) reached"],
  [
    new InstructionConflictError("Review the current instructions before restoring."),
    "CONFLICT",
    409,
    "Review the current instructions before restoring.",
  ],
  [new BotSectionNameConflictError(), "CONFLICT", 409, "Section name already used"],
  [new ComputerBusyError(), "CONFLICT", 409, "Computer is busy"],
  [new ComputerSpaceDeletingError(), "CONFLICT", 409, "Computer is busy"],
  [new PageListCursorError(), "BAD_REQUEST", 400, "Invalid page list cursor"],
  [
    new PageShareConflictError(),
    "CONFLICT",
    409,
    "The page's sharing changed at the same time; try again",
  ],
  [new ArtifactListCursorError(), "BAD_REQUEST", 400, "Invalid artifact cursor"],
  [
    new NameTakenError("skill"),
    "CONFLICT",
    409,
    "A skill with that name already exists in one of these spaces.",
  ],
  [
    new NameTakenError("mcpServer"),
    "CONFLICT",
    409,
    "An MCP server with that name already exists in one of these spaces.",
  ],
];

/** What a client receives when a procedure throws `error`, through the app's error path. */
async function answer(error: unknown) {
  const router = {
    fail: os.handler(() => {
      throw error;
    }),
  };
  const rpc = new RPCHandler(router, {
    clientInterceptors: [onError((thrown, { path }) => handleRpcError(thrown, path))],
  });
  const { response } = await rpc.handle(
    new Request("https://api.example.test/rpc/fail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { prefix: "/rpc" },
  );
  return { status: response?.status, body: await response?.json() };
}

describe("domain refusals answered by the central mapping", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  it.each(REFUSALS.map(([error, ...expected]) => [error.name, error, ...expected] as const))(
    "answers %s exactly as its routes did by hand",
    async (_name, error, code, status, message) => {
      const sink = createTestSink();
      installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

      const mapped = await answer(error);

      expect(mapped).toEqual(await answer(new ORPCError(code, { message })));
      expect(mapped).toMatchObject({ status, body: { json: { code, status, message } } });
      expect(sink.events).toEqual([]);
    },
  );

  it("keeps the kind's status for a refusal with its own code", async () => {
    const refusal = new ClientError("BAD_REQUEST", "Pick another name", "NAME_TAKEN");

    await expect(answer(refusal)).resolves.toMatchObject({
      status: 400,
      body: { json: { code: "NAME_TAKEN", status: 400, message: "Pick another name" } },
    });
  });

  it("answers an ended session exactly as a bare unauthorized answer", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    const mapped = await answer(new ClientError("UNAUTHORIZED", "Unauthorized"));

    expect(mapped).toEqual(await answer(new ORPCError("UNAUTHORIZED")));
    expect(mapped).toMatchObject({
      status: 401,
      body: { json: { code: "UNAUTHORIZED", status: 401, message: "Unauthorized" } },
    });
    expect(sink.events).toEqual([]);
  });

  it("answers a known outage as unavailable and still reports it with its cause", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const outage = new ClientError("SERVICE_UNAVAILABLE", "Service Unavailable", undefined, {
      cause: new Error("key service unreachable"),
    });

    const mapped = await answer(outage);

    expect(mapped).toMatchObject({
      status: 503,
      body: { json: { code: "SERVICE_UNAVAILABLE", status: 503, message: "Service Unavailable" } },
    });
    expect(sink.events).toMatchObject([
      {
        level: "error",
        message: "rpc fail failed",
        error: { cause: { cause: { message: "key service unreachable" } } },
      },
    ]);
    sink.events.length = 0;
    expect(mapped).toEqual(await answer(new ORPCError("SERVICE_UNAVAILABLE")));
  });

  it("reports a path that leaves the workspace as a server failure unless a route answers it", async () => {
    // The path may be one a computer provider listed, not one the caller typed.
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    await expect(
      answer(new WorkspacePathError("Path escapes the computer workspace")),
    ).resolves.toMatchObject({ status: 500 });
    expect(sink.events).toMatchObject([{ level: "error", message: "rpc fail failed" }]);
  });

  it("still reports an error that carries no client answer as a server failure", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    await expect(answer(new Error("connection reset"))).resolves.toMatchObject({ status: 500 });
    expect(sink.events).toMatchObject([{ level: "error", message: "rpc fail failed" }]);
  });
});
