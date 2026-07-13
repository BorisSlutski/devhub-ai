/** Whether a describe-table IPC response should update workspace state. */
export function shouldApplyDescribeResult(
  currentGen: number,
  responseGen: number,
  expandedTable: string | null,
  tableName: string,
): boolean {
  return currentGen === responseGen && expandedTable === tableName
}
