/** Agent Skills resources are read as text only; the importer never executes them. */
const AGENT_SKILL_TEXT_FILE =
  /\.(md|mdx|txt|json|jsonc|json5|jsonl|ya?ml|csv|tsv|toml|ini|cfg|conf|xml|html|css|scss|py|sh|bash|zsh|js|mjs|cjs|jsx|ts|mts|cts|tsx|rb|go|rs|php|pl|lua|ps1|bat|cmd|sql|r|m|swift|java|kt|scala|c|h|cpp|hpp|cs|ipynb|sv|v|vhd|vhdl|xdc|tcl|overlay|service|timer|tmpl|example|lock|dockerfile)$/i;
const SKILL_RESOURCE_DIRS = ["assets", "references", "scripts", "templates"];
const AGENT_SKILL_TEXT_FILENAMES = new Set([
  "authors",
  "changelog",
  "contributing",
  "copying",
  "dockerfile",
  "license",
  "makefile",
  "notice",
  "readme",
]);

export function isSkillDocumentPath(path: string): boolean {
  return (
    path === "SKILL.md" ||
    /^[^/]+\/SKILL\.md$/.test(path) ||
    /^skills\/[^/]+\/SKILL\.md$/.test(path) ||
    /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(path)
  );
}

export function skillFolder(path: string): string {
  return path === "SKILL.md" ? "" : path.slice(0, -"SKILL.md".length);
}

export function isWithinSkillFolder(path: string, folder: string): boolean {
  return folder ? path.startsWith(folder) : path !== "SKILL.md";
}

export function ownedBySkill(
  path: string,
  document: string,
  documents: ReadonlySet<string>,
): boolean {
  const folder = skillFolder(document);
  if (path === document || !isWithinSkillFolder(path, folder)) return false;
  for (
    let slash = path.lastIndexOf("/");
    slash >= folder.length;
    slash = path.lastIndexOf("/", slash - 1)
  ) {
    if (documents.has(`${path.slice(0, slash + 1)}SKILL.md`)) return false;
  }
  return true;
}

export function isAgentSkillResourcePath(path: string): boolean {
  const filename = path.split("/").at(-1) ?? "";
  const directory = path.split("/")[0] ?? "";
  return (
    AGENT_SKILL_TEXT_FILE.test(path) ||
    AGENT_SKILL_TEXT_FILENAMES.has(filename.toLowerCase()) ||
    (!filename.includes(".") && ["references", "scripts", "templates"].includes(directory))
  );
}

export function referencedSkillResources(body: string, siblings: readonly string[]): string[] {
  const mentionedDirectories = new Set(
    SKILL_RESOURCE_DIRS.filter((directory) =>
      new RegExp(
        `(?:^|[^\\w./-])(?:\\./|\\{baseDir\\}/)?${directory}/(?=$|[^\\w./-]|\\.(?:$|\\s))`,
      ).test(body),
    ),
  );
  const localBody = body.replaceAll("{baseDir}/", "./");
  const tokens = new Set(
    [
      ...(localBody.match(/[^\s`"'<>()[\]{}]+/g) ?? []),
      ...(localBody.match(/[^\s`"'<>]+/g) ?? []),
      ...localBody.split(/[`"()<>]/),
      ...localBody.split(/[`"<>]/),
    ].flatMap((token) => {
      const raw = token.trim().replace(/^\.\//, "");
      const withoutFragment = raw.split("#", 1)[0]!;
      return [raw, withoutFragment, withoutFragment.replace(/[.,;:!?]+$/, "")];
    }),
  );
  const explicitlyNamed = new Set(
    siblings.filter((path) => tokens.has(path) || tokens.has(encodeURI(path))),
  );

  return siblings.filter((path) => {
    const first = path.split("/")[0] ?? "";
    return explicitlyNamed.has(path) || mentionedDirectories.has(first);
  });
}
