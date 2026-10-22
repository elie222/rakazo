/** Select the creator's repository without trusting directory search result shapes or substrings. */
export function findCreatorSkillUrl(
  skills: unknown,
  author: string,
  repo: string,
  skillPathSlug?: string,
): URL | undefined {
  if (!Array.isArray(skills)) return undefined;
  const matches: URL[] = [];
  const normalizedSkillPath = skillPathSlug?.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  for (const skill of skills) {
    if (!skill || typeof skill !== "object" || typeof skill.githubUrl !== "string") continue;
    let url: URL;
    try {
      url = new URL(skill.githubUrl);
    } catch {
      continue;
    }
    const [owner, name] = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      owner?.toLowerCase() === author.toLowerCase() &&
      name?.toLowerCase() === repo.toLowerCase()
    ) {
      if (normalizedSkillPath) {
        const cleanPathname = url.pathname.toLowerCase().replace(/\/+$/, "");
        if (
          cleanPathname.endsWith(`/${normalizedSkillPath}`) ||
          cleanPathname.endsWith(`/${normalizedSkillPath}/skill.md`)
        ) {
          return url;
        }
      }
      matches.push(url);
    }
  }
  return matches[0];
}

/** Repository roots use the Contents API's default branch; explicit refs stay explicit. */
export function githubSkillContentUrl(input: URL): URL {
  const url = new URL(input);
  if (
    url.hostname !== "github.com" ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port
  )
    return url;
  const [owner, repo, view, ...path] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo) return url;
  if (!view) return new URL(`https://api.github.com/repos/${owner}/${repo}/contents/SKILL.md`);
  if (view === "blob" || view === "tree") {
    url.hostname = "raw.githubusercontent.com";
    url.pathname = `/${[owner, repo, ...path, ...(view === "tree" ? ["SKILL.md"] : [])].join("/")}`;
  }
  return url;
}
