/** Select the creator's repository without trusting directory search result shapes or substrings. */
export function findCreatorSkillUrl(
  skills: unknown,
  author: string,
  repo: string,
): URL | undefined {
  if (!Array.isArray(skills)) return undefined;
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
      return url;
    }
  }
  return undefined;
}
