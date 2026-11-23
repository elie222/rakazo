import type {
  AnyContractProcedure,
  InferContractRouterInputs,
  InferContractRouterOutputs,
} from "@orpc/contract";
import { accountRpc } from "../account/account-rpc.js";
import { artifactsRpc } from "../artifacts/artifacts-rpc.js";
import { billingRpc } from "../billing/billing-rpc.js";
import { botsRpc } from "../bots/bots-rpc.js";
import { serverRpc } from "../clients/server-rpc.js";
import { computersRpc } from "../computers/computers-rpc.js";
import { integrationsRpc } from "../integrations/integrations-rpc.js";
import { meetingCalendarRpc } from "../meetings/calendar.js";
import { meetingsRpc } from "../meetings/meetings.js";
import { modelsRpc } from "../models/models-rpc.js";
import { routinesRpc } from "../routines/routines-rpc.js";
import { runsRpc } from "../runs/runs-rpc.js";
import { skillsRpc } from "../skills/skills-rpc.js";
import { spacesRpc } from "../spaces/spaces-rpc.js";
import { threadsRpc } from "../threads/threads-rpc.js";

export const appContract = {
  ...accountRpc,
  ...billingRpc,
  ...spacesRpc,
  ...serverRpc,
  ...computersRpc,
  ...modelsRpc,
  ...botsRpc,
  ...threadsRpc,
  ...meetingsRpc,
  ...meetingCalendarRpc,
  ...routinesRpc,
  ...artifactsRpc,
  ...skillsRpc,
  ...integrationsRpc,
  ...runsRpc,
};

export type AppContract = typeof appContract;

type ProcedurePaths<Router, Prefix extends string = ""> = {
  [Key in keyof Router & string]: Router[Key] extends AnyContractProcedure
    ? `${Prefix}${Key}`
    : ProcedurePaths<Router[Key], `${Prefix}${Key}/`>;
}[keyof Router & string];

type AtPath<Tree, Path extends string> = Path extends `${infer Head}/${infer Rest}`
  ? Head extends keyof Tree
    ? AtPath<Tree[Head], Rest>
    : never
  : Path extends keyof Tree
    ? Tree[Path]
    : never;

/** A procedure's URL path under `/rpc/`, such as `bots/list`. */
export type RpcPath = ProcedurePaths<AppContract>;
type RpcInputs = { [Path in RpcPath]: AtPath<InferContractRouterInputs<AppContract>, Path> };
type RpcOutputs = { [Path in RpcPath]: AtPath<InferContractRouterOutputs<AppContract>, Path> };
export type RpcInput<Path extends RpcPath> = RpcInputs[Path];
export type RpcOutput<Path extends RpcPath> = RpcOutputs[Path];
