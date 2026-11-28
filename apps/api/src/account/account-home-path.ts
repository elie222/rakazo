import path from "node:path";

/** Preserve literal POSIX backslashes without interpreting them as path separators on restore. */
export function isAccountHomePath(value: string) {
  if (value.includes("\0") || path.win32.parse(value).root) return false;
  if (process.platform === "win32" && value.includes("\\")) return false;
  return (
    value.split("/").every(Boolean) &&
    !value.split(/[\\/]/).some((part) => part === "." || part === "..")
  );
}
