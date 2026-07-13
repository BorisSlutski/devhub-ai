/** Wix's Trino/LDAP identity requires the full `user@wix.com` form — bare usernames are rejected. */
export function normalizeWixUser(user: string): string {
  const trimmed = user.trim()
  return trimmed && !trimmed.includes('@') ? `${trimmed}@wix.com` : trimmed
}
