import { z } from "zod";
import type { AppEmulator } from "../../apps/app-emulator.js";
import { FilesEmulator } from "../../apps/files.js";
import { MailEmulator } from "../../apps/mail.js";
import { blocksFromText, NotesEmulator } from "../../apps/notes.js";
import type { EvalCase } from "../cases.js";
import type { EvalServices } from "../services.js";

/** The owner of the connected mail, files and notes accounts. Only the name matches the trial's
 * sign-up, whose email is random, so cases never rely on the product account having this address. */
const OWNER = { name: "Eval User", email: "owner@home.example" };

const MailSchema = z
  .object({
    from: z.string().min(1),
    subject: z.string().min(1),
    body: z.string().min(1),
    to: z.array(z.string().min(1)).optional(),
    /** Days before the trial; later entries default to more recent. */
    daysAgo: z.number().min(0).optional(),
  })
  .strict();

const FileSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["document", "pdf", "spreadsheet"]).optional(),
    owner: z.string().min(1).optional(),
    /** Text of a document or PDF. */
    content: z.string().optional(),
    /** Rows of a spreadsheet's one sheet. */
    rows: z.array(z.array(z.string())).optional(),
  })
  .strict()
  .refine(
    ({ kind, rows, content }) =>
      rows
        ? content === undefined && (kind ?? "spreadsheet") === "spreadsheet"
        : kind !== "spreadsheet",
    { message: "A spreadsheet takes rows; a document or PDF takes content" },
  );

const NotePageSchema = z
  .object({
    title: z.string().min(1),
    /** Markdown-ish lines, imported as blocks. */
    text: z.string().min(1),
    editedBy: z.string().min(1).optional(),
  })
  .strict();

/**
 * Outside content a case puts in front of the bot: what a page fetch or search returns, the
 * messages in a connected mailbox, documents in connected file storage, pages in a connected
 * notes workspace, and files on the bot's own computer.
 */
export const SourcesSchema = z
  .object({
    web: z
      .object({
        /** Text served for these exact URLs; any other URL serves a generic page. */
        pages: z.record(z.url(), z.string()).optional(),
        search: z
          .array(z.object({ title: z.string(), url: z.url(), snippet: z.string() }).strict())
          .optional(),
      })
      .strict()
      .optional(),
    mail: z.array(MailSchema).min(1).optional(),
    files: z.array(FileSchema).min(1).optional(),
    notes: z.array(NotePageSchema).min(1).optional(),
    computerFiles: z
      .array(z.object({ path: z.string().min(1), content: z.string() }).strict())
      .min(1)
      .optional(),
  })
  .strict();
export type Sources = z.infer<typeof SourcesSchema>;

const key = (prefix: string, index: number) => `${prefix}-${index + 1}`;
const age = (count: number, index: number, daysAgo?: number) => daysAgo ?? (count - index) / 24;

function sourceApps(sources: Sources, now: Date): AppEmulator[] {
  const at = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const apps: AppEmulator[] = [];
  const { mail, files, notes } = sources;
  if (mail)
    apps.push(
      new MailEmulator(
        {
          account: OWNER,
          labels: [],
          threads: mail.map((message, index) => ({
            key: key("mail", index),
            subject: message.subject,
            messages: [
              {
                from: message.from,
                to: message.to ?? [`${OWNER.name} <${OWNER.email}>`],
                date: at(age(mail.length, index, message.daysAgo)),
                body: message.body,
                unread: true,
              },
            ],
          })),
        },
        { now },
      ),
    );
  if (files)
    apps.push(
      new FilesEmulator(
        {
          account: OWNER,
          baseUrl: "https://files.home.example",
          files: files.map((file, index) => {
            const kind = file.kind ?? (file.rows ? "spreadsheet" : "document");
            return {
              key: key("file", index),
              name: file.name,
              kind,
              owner: file.owner ?? OWNER.email,
              access: file.owner && file.owner !== OWNER.email ? "reader" : "owner",
              modified: at(age(files.length, index)),
              ...(kind === "spreadsheet"
                ? { sheets: [{ name: "Sheet1", rows: file.rows ?? [] }] }
                : { content: file.content ?? "" }),
            };
          }),
        },
        { now },
      ),
    );
  if (notes)
    apps.push(
      new NotesEmulator(
        {
          workspace: "Workspace",
          baseUrl: "https://notes.home.example",
          member: OWNER.name,
          databases: [],
          pages: notes.map((page, index) => ({
            key: key("page", index),
            title: page.title,
            blocks: blocksFromText(page.text),
            edited: at(age(notes.length, index)),
            ...(page.editedBy ? { editedBy: page.editedBy } : {}),
          })),
        },
        { now },
      ),
    );
  return apps;
}

/** The parts of an eval case that put the sources in front of the bot. */
export function sourcesCase(
  sources: Sources | undefined,
): Pick<EvalCase, "apps" | "configure" | "computerFiles" | "fixtureData"> {
  if (!sources) return {};
  const { web, mail, files, notes, computerFiles } = sources;
  return {
    fixtureData: sources,
    ...(mail || files || notes ? { apps: (now: Date) => sourceApps(sources, now) } : {}),
    ...(web
      ? {
          configure: (services: EvalServices) => {
            Object.assign(services.web.pages, web.pages);
            if (web.search) services.web.searchHits = web.search;
          },
        }
      : {}),
    ...(computerFiles ? { computerFiles } : {}),
  };
}
