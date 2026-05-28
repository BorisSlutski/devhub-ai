/**
 * Append LIMIT to bare SELECT/WITH so MySQL does not stream millions of rows over the tunnel.
 */
export function capUnboundedSelect(
  sql: string,
  maxRows: number,
): { sql: string; rowCapApplied: boolean } {
  const trimmed = sql.trim()
  const body = trimmed.replace(/;+\s*$/, '')
  if (/;\s*\S/.test(body)) return { sql, rowCapApplied: false }
  if (!/^\s*(select|with)\b/i.test(body)) return { sql, rowCapApplied: false }
  if (/\blimit\s+(\d+|\?)/i.test(body)) return { sql, rowCapApplied: false }
  return { sql: `${body} LIMIT ${maxRows + 1}`, rowCapApplied: true }
}
