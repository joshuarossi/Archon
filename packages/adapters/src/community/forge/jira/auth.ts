/**
 * Jira user authorization utilities.
 *
 * Jira identifies users by Atlassian `accountId` (an opaque, case-sensitive
 * string — NOT lower-cased like a username). All authorization is exact-match.
 */

/**
 * Parse comma-separated Atlassian accountIds from an environment variable.
 * Returns empty array if not set (open access mode).
 *
 * NOTE: accountIds are case-sensitive opaque strings — do not lowercase.
 */
export function parseAllowedAccountIds(envValue: string | undefined): string[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  return envValue
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '');
}

/**
 * Check whether a Jira accountId is authorized.
 * Returns true if:
 * - allowed is empty (open access mode)
 * - accountId is an exact match in allowed
 */
export function isJiraUserAuthorized(accountId: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) {
    return true;
  }

  if (accountId === undefined || accountId.trim() === '') {
    return false;
  }

  return allowed.includes(accountId);
}
