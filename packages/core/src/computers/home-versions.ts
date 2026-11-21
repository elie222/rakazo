export interface HomeVersionChoice {
  key: string;
  label: string;
}

/** Kept versions of a computer's files as choices, each labelled with the time it was saved. */
export function homeVersionChoices(
  versions: readonly { id: string; savedAt: string }[],
  locale: string | undefined,
): HomeVersionChoice[] {
  const format = new Intl.DateTimeFormat(locale || undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return versions.map((version) => ({
    key: version.id,
    label: format.format(new Date(version.savedAt)),
  }));
}
