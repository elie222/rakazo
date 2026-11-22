/**
 * Asks password managers to leave a field alone. Vault fields hold logins for other sites, so
 * offering to fill or save this site's login there is always wrong. Each manager reads its own
 * attribute (1Password, LastPass, Bitwarden, Dashlane); browsers' own managers follow
 * `autoComplete`, which each field sets itself.
 */
export const passwordManagerIgnore = {
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;
