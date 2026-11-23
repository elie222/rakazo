// @vitest-environment jsdom

import { ORPCError } from "@orpc/client";
import type { AgentSkill, AgentSkillCatalogEntry } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listFiles: vi.fn(),
  getFile: vi.fn(),
  removeFile: vi.fn(),
}));
// One space, so no "Available in" choice appears.
vi.mock("../integrations/space-availability", () => ({
  AvailabilityControl: () => null,
  AvailabilityLabel: () => null,
  reachesOtherSpaces: () => false,
  useOwnSpaces: () => [],
}));
vi.mock("../../lib/query/rpc", () => {
  const client = { agentSkills: api };
  return {
    rpc: client,
    rpcForSpace: () => client,
    createSpaceRpc: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: string }) => <div data-markdown="">{children}</div>,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Field: Container,
    FieldLabel: ({ htmlFor, children }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Skeleton: Container,
  };
});

import { spaceQueries } from "../../lib/query/query";
import { AgentSkills } from "./agent-skills";

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
let queryClient = newClient();
let container: HTMLDivElement;
let root: Root;

const document_ = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

function saved(entry: AgentSkillCatalogEntry, body = "Steps"): AgentSkill {
  return {
    ...entry,
    content: document_(entry.name, entry.description, body),
    createdAt: "2026-11-23T10:00:00.000Z",
    updatedAt: "2026-11-23T10:00:00.000Z",
  };
}

const report: AgentSkillCatalogEntry = {
  id: "skill-report",
  name: "weekly-report",
  description: "Write the Monday report",
  source: "user",
  readOnly: false,
};
const interrogate: AgentSkillCatalogEntry = {
  id: "builtin:Interrogate",
  name: "Interrogate",
  description: "Review a change",
  source: "builtin",
  readOnly: true,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const fn of Object.values(api)) fn.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  queryClient.clear();
  queryClient = newClient();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(flush);
  await act(flush);
}

async function show(node: ReactNode = <AgentSkills />) {
  await act(async () =>
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>),
  );
  await settle();
}

const button = (text: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === text || entry.textContent?.includes(text),
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
};
const hasButton = (text: string) =>
  [...container.querySelectorAll("button")].some((entry) => entry.textContent?.includes(text));
async function click(text: string) {
  await act(async () => button(text).click());
  await settle();
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(element);
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("badges built-in skills, leaves plugin skills to their plugin and opens built-ins read-only", async () => {
  api.list.mockResolvedValue([
    interrogate,
    { ...report, id: "plugin:mail", name: "Triage mail", source: "plugin", readOnly: true },
    report,
  ]);
  api.get.mockResolvedValue(saved(interrogate, "Challenge the change."));
  await show();
  expect(button("Interrogate").textContent).toContain("Built-in");
  // Plugin skills are listed by their plugin in the Skills dialog, not one by one here.
  expect(container.textContent).not.toContain("Triage mail");
  expect(button("weekly-report").textContent).not.toContain("Built-in");

  await click("Interrogate");
  expect(api.get).toHaveBeenCalledWith({ skillId: "builtin:Interrogate" }, expect.anything());
  // Built-in skills have no files of their own to ask for.
  expect(api.listFiles).not.toHaveBeenCalled();
  expect(container.querySelector("[data-markdown]")?.textContent).toBe("Challenge the change.");
  expect(hasButton("Edit")).toBe(false);
  expect(hasButton("Delete")).toBe(false);
  expect(hasButton("Add file")).toBe(false);
  await click("All skills");
  expect(hasButton("weekly-report")).toBe(true);
});

it("opens a skill as a folder and reads each file by its path", async () => {
  api.list.mockResolvedValue([report]);
  api.get.mockResolvedValue(saved(report, "Fill templates/report.html."));
  api.listFiles.mockResolvedValue([
    { path: "templates/report.html", bytes: 15 },
    { path: "NOTES.md", bytes: 6 },
  ]);
  api.getFile.mockImplementation(async ({ path }: { path: string }) => ({
    path,
    content: path === "NOTES.md" ? "# Tone" : "<h1>{{t}}</h1>",
  }));
  await show();
  await click("weekly-report");
  const names = [...container.querySelectorAll("nav button")].map((row) =>
    row.textContent?.replace(/\d+ B$/, "").trim(),
  );
  expect(names).toEqual(["SKILL.md", "NOTES.md", "report.html", "Add file"]);
  expect(container.textContent).toContain("templates/");
  expect(container.querySelector("[data-markdown]")?.textContent).toBe(
    "Fill templates/report.html.",
  );

  await click("report.html");
  expect(api.getFile).toHaveBeenCalledWith(
    { skillId: report.id, path: "templates/report.html" },
    expect.anything(),
  );
  // Anything but markdown reads exactly as written.
  expect(container.querySelector("pre")?.textContent).toBe("<h1>{{t}}</h1>");
  await click("NOTES.md");
  expect(container.querySelector("[data-markdown]")?.textContent).toBe("# Tone");
});

it("saves an edited file only with Save, and only once it changed", async () => {
  api.list.mockResolvedValue([report]);
  api.get.mockResolvedValue(saved(report));
  api.listFiles.mockResolvedValue([{ path: "NOTES.md", bytes: 6 }]);
  api.getFile.mockResolvedValue({ path: "NOTES.md", content: "# Tone" });
  const saving = deferred<AgentSkill>();
  api.update.mockReturnValue(saving.promise);
  await show();
  await click("weekly-report");
  await click("NOTES.md");
  await click("Edit");
  const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="NOTES.md"]');
  expect(editor?.value).toBe("# Tone");
  expect(button("Save").disabled).toBe(true);
  await type(editor!, "# Tone\nShort.");
  expect(api.update).not.toHaveBeenCalled();
  expect(button("Save").disabled).toBe(false);
  await click("Save");
  expect(api.update).toHaveBeenCalledOnce();
  expect(api.update).toHaveBeenCalledWith({
    skillId: report.id,
    file: { path: "NOTES.md", content: "# Tone\nShort." },
  });
  // Held while the save is in flight, so a second click sends nothing.
  expect(button("Save").disabled).toBe(true);
  api.getFile.mockResolvedValue({ path: "NOTES.md", content: "# Tone\nShort." });
  await act(async () => saving.resolve(saved(report)));
  await settle();
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.querySelector("[data-markdown]")?.textContent).toBe("# Tone\nShort.");
});

it("asks before leaving a file with unsaved changes", async () => {
  api.list.mockResolvedValue([report]);
  api.get.mockResolvedValue(saved(report));
  api.listFiles.mockResolvedValue([{ path: "NOTES.md", bytes: 6 }]);
  api.getFile.mockResolvedValue({ path: "NOTES.md", content: "# Tone" });
  await show();
  await click("weekly-report");
  await click("NOTES.md");
  await click("Edit");
  await type(container.querySelector("textarea")!, "Changed");
  await click("SKILL.md");
  expect(container.textContent).toContain("Your changes are not saved.");
  await click("Keep editing");
  expect(container.querySelector("textarea")?.value).toBe("Changed");
  await click("All skills");
  await click("Discard");
  expect(hasButton("weekly-report")).toBe(true);
  expect(api.update).not.toHaveBeenCalled();
});

it("edits SKILL.md as a name, a description and instructions", async () => {
  api.list.mockResolvedValue([report]);
  api.get.mockResolvedValue(saved(report, "Old steps"));
  api.listFiles.mockResolvedValue([]);
  api.update.mockResolvedValue(saved(report, "New steps"));
  await show();
  await click("weekly-report");
  await click("Edit");
  expect(container.querySelector<HTMLInputElement>("#skill-name")?.value).toBe("weekly-report");
  const body = container.querySelector<HTMLTextAreaElement>("#skill-body")!;
  // The frontmatter is the fields above, not text to edit by hand.
  expect(body.value).toBe("Old steps");
  await type(body, "New steps");
  await click("Save");
  expect(api.update).toHaveBeenCalledWith({
    skillId: report.id,
    name: "weekly-report",
    description: "Write the Monday report",
    body: "New steps",
  });
});

it("adds a file, says why the server refused one, and removes one after confirmation", async () => {
  api.list.mockResolvedValue([report]);
  api.get.mockResolvedValue(saved(report));
  api.listFiles.mockResolvedValue([{ path: "NOTES.md", bytes: 6 }]);
  api.getFile.mockResolvedValue({ path: "NOTES.md", content: "# Tone" });
  api.update.mockRejectedValueOnce(
    new ORPCError("BAD_REQUEST", { message: "A skill can have at most 40 files." }),
  );
  api.update.mockResolvedValueOnce(saved(report));
  api.removeFile.mockResolvedValue({ ok: true });
  await show();
  await click("weekly-report");
  await click("Add file");
  await type(container.querySelector<HTMLInputElement>("#skill-file-path")!, "refs/a.md");
  await type(container.querySelector<HTMLTextAreaElement>("#skill-file-text")!, "A");
  // The new path is a row of the tree; its text has the rest of the page.
  expect(container.querySelector("nav #skill-file-path")).not.toBeNull();
  const submit = () => click("Save");
  await submit();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("A skill can have at most 40 files."),
  );
  await submit();
  expect(api.update).toHaveBeenLastCalledWith({
    skillId: report.id,
    file: { path: "refs/a.md", content: "A" },
  });

  // The new file opens once the save and its refresh are done.
  await vi.waitFor(() => expect(container.querySelector("#skill-file-path")).toBeNull());
  expect(container.querySelector("section")?.getAttribute("aria-label")).toBe("refs/a.md");
  await click("NOTES.md");
  // Deleting is part of editing the file, so reading it shows no destructive action.
  expect(hasButton("Delete file")).toBe(false);
  await click("Edit");
  await click("Delete file");
  expect(api.removeFile).not.toHaveBeenCalled();
  await click("Delete this file?");
  expect(api.removeFile).toHaveBeenCalledWith({ skillId: report.id, path: "NOTES.md" });
});

it("creates a skill from its fields, opens it, and adds it to the composer's cached list", async () => {
  const sharedKey = spaceQueries(null, null).agentSkills.list.queryKey();
  queryClient.setQueryData(sharedKey, [report]);
  const read = deferred<AgentSkillCatalogEntry[]>();
  const created = { ...report, id: "skill-new", name: "greet", description: "Say hello" };
  api.list.mockImplementationOnce(() => read.promise).mockResolvedValue([report, created]);
  api.create.mockResolvedValue(saved(created, "Be kind."));
  api.get.mockResolvedValue(saved(created, "Be kind."));
  api.listFiles.mockResolvedValue([]);
  await show();
  // The composer's cached list shows at once, while the fresh read is still out.
  expect(hasButton("weekly-report")).toBe(true);
  await click("New skill");
  expect(hasButton("Add file")).toBe(false);
  await type(container.querySelector<HTMLInputElement>("#skill-name")!, "greet");
  await type(container.querySelector<HTMLInputElement>("#skill-description")!, "Say hello");
  await type(container.querySelector<HTMLTextAreaElement>("#skill-body")!, "Be kind.");
  await click("Save");
  expect(api.create).toHaveBeenCalledWith({
    name: "greet",
    description: "Say hello",
    body: "Be kind.",
  });
  await act(async () => read.resolve([report]));
  await settle();
  expect(container.querySelector("h3")?.textContent).toBe("greet");
  expect(queryClient.getQueryData<AgentSkillCatalogEntry[]>(sharedKey)?.map((s) => s.id)).toEqual([
    report.id,
    created.id,
  ]);
});

it("previews a new markdown file as it will read, and keeps the text to write", async () => {
  api.list.mockResolvedValue([report]);
  api.get.mockResolvedValue(saved(report));
  api.listFiles.mockResolvedValue([]);
  await show();
  await click("weekly-report");
  await click("Add file");
  // Only markdown has a preview; other text is shown exactly as written anyway.
  await type(container.querySelector<HTMLInputElement>("#skill-file-path")!, "templates/a.html");
  expect(hasButton("Preview")).toBe(false);
  await type(container.querySelector<HTMLInputElement>("#skill-file-path")!, "refs/tone.md");
  await type(container.querySelector<HTMLTextAreaElement>("#skill-file-text")!, "# Tone\nShort.");
  await click("Preview");
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.querySelector("[data-markdown]")?.textContent).toBe("# Tone\nShort.");
  await click("Write");
  expect(container.querySelector<HTMLTextAreaElement>("#skill-file-text")?.value).toBe(
    "# Tone\nShort.",
  );
});
