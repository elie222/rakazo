import { oc } from "@orpc/contract";
import * as z from "zod";
import { SpaceAvailabilitySchema } from "../account/space-availability.js";
import { Id } from "../ids.js";
import { botId } from "../rpc/inputs.js";
import {
  AccountItemSchema,
  AgentSkillCatalogEntrySchema,
  AgentSkillSchema,
  AvailabilityKindSchema,
  CreateAgentSkillInput,
  UpdateAgentSkillInput,
} from "./agent-skills.js";
import {
  SkillPlaybookSchema,
  TaughtSkillSchema,
  TeachRecordingEventSchema,
} from "./taught-skills.js";

export const skillsRpc = {
  skills: {
    list: oc.input(botId).output(z.array(TaughtSkillSchema)),
    get: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    start: oc
      .input(z.object({ botId: Id, goal: z.string().min(1).max(4000) }))
      .output(TaughtSkillSchema),
    appendEvent: oc
      .input(z.object({ skillId: Id, event: TeachRecordingEventSchema }))
      .output(TaughtSkillSchema),
    snapshot: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    stop: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    updateDraft: oc
      .input(
        z.object({
          skillId: Id,
          name: z.string().optional(),
          playbook: SkillPlaybookSchema,
        }),
      )
      .output(TaughtSkillSchema),
    save: oc
      .input(z.object({ skillId: Id, name: z.string().optional() }))
      .output(TaughtSkillSchema),
    testRun: oc
      .input(z.object({ skillId: Id, prompt: z.string().optional() }))
      .output(z.object({ runId: Id })),
    remove: oc.input(z.object({ skillId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  /** Skills: reusable how-to recipes (not taught/demo skills). */
  agentSkills: {
    list: oc.output(z.array(AgentSkillCatalogEntrySchema)),
    get: oc
      .input(
        z
          .object({ skillId: Id.optional(), name: z.string().min(1).max(80).optional() })
          .superRefine((input, ctx) => {
            if (!input.skillId && !input.name?.trim()) {
              ctx.addIssue({
                code: "custom",
                message: "Provide skillId or name",
                path: ["skillId"],
              });
            }
          }),
      )
      .output(AgentSkillSchema),
    create: oc.input(CreateAgentSkillInput).output(AgentSkillSchema),
    update: oc.input(UpdateAgentSkillInput).output(AgentSkillSchema),
    remove: oc.input(z.object({ skillId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  availability: {
    set: oc
      .input(z.object({ kind: AvailabilityKindSchema, id: Id }).and(SpaceAvailabilitySchema))
      .output(SpaceAvailabilitySchema),
    /** The user's own skills, MCP servers, plugins and tool sources across their spaces. */
    items: oc.output(z.array(AccountItemSchema)),
    /** Make exactly the listed items available in a space, keeping each one's other spaces. */
    chooseForSpace: oc
      .input(
        z.object({
          spaceId: Id,
          items: z.array(z.object({ kind: AvailabilityKindSchema, id: Id })).max(500),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
  },
};
