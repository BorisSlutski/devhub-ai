/**
 * Fix common mistake: single-quoted table identifiers in FROM/JOIN clauses.
 * MySQL uses backticks (or bare names) for identifiers; single quotes denote string literals.
 */
export function normalizeSqlSingleQuotedTableIds(sql: string): { sql: string; changed: boolean } {
  let changed = false
  const normalized = sql.replace(
    /\b(FROM|JOIN)\s+'([A-Za-z0-9_]+)'/gi,
    (_match, clause: string, name: string) => {
      changed = true
      return `${clause} \`${name}\``
    },
  )
  return { sql: normalized, changed }
}
