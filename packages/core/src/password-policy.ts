/**
 * Length limits for new passwords, with no composition rules. NIST SP 800-63B-4 asks for at least
 * 15 characters when a password is the only factor. Sign-in never checks the minimum, so shorter
 * passwords set before it was raised keep working.
 */
export const MIN_PASSWORD_LENGTH = 16;
export const MAX_PASSWORD_LENGTH = 128;

/** iOS AutoFill rules, so a generated password satisfies the server. */
export const PASSWORD_RULES = `minlength: ${MIN_PASSWORD_LENGTH}; maxlength: ${MAX_PASSWORD_LENGTH};`;
