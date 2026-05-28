import React, { memo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import type { Extension } from '@codemirror/state'

interface TableInfo {
  name: string
  type: 'TABLE' | 'VIEW'
  engine: string | null
  rows: number | null
  comment: string
}

interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  key: string
  defaultValue: string | null
  extra: string
}

interface QueryResult {
  columns: { name: string; type: string }[]
  rows: unknown[][]
  rowCount: number
  affectedRows: number
  executionTimeMs: number
  error?: string
  rowCapApplied?: boolean
  truncated?: boolean
}

interface DbSessionWorkspace {
  tables: TableInfo[]
  tablesLoading: boolean
  tablesError: string | null
  expandedTable: string | null
  tableColumns: Record<string, ColumnInfo[]>
  columnsLoading: string | null
  columnsError: Record<string, string>
  query: string
  result: QueryResult | null
  queryRunning: boolean
  activeResultTab: 'results' | 'messages'
  messages: string[]
}

export interface DbSessionWorkspacePanelProps {
  sessionId: string
  dbName: string
  workspace: DbSessionWorkspace
  isActive: boolean
  queryElapsedSec: number
  tablePreviewLimit: number
  resultsDisplayCap: number
  cmExtensions: Extension[]
  formatMs: (ms: number) => string
  renderCellValue: (value: unknown) => React.ReactNode
  onQueryChange: (query: string) => void
  onRunQuery: (sqlOverride?: string) => void
  onCancelQuery: () => void
  onFetchTables: () => void
  onToggleTable: (tableName: string) => void
  onRetryColumns: (tableName: string) => void
  onTableClick: (tableName: string) => void
  onActiveResultTab: (tab: 'results' | 'messages') => void
  onClearMessages: () => void
}

function DbSessionWorkspacePanelInner({
  dbName,
  workspace: ws,
  isActive,
  queryElapsedSec,
  tablePreviewLimit,
  resultsDisplayCap,
  cmExtensions,
  formatMs,
  renderCellValue,
  onQueryChange,
  onRunQuery,
  onCancelQuery,
  onFetchTables,
  onToggleTable,
  onRetryColumns,
  onTableClick,
  onActiveResultTab,
  onClearMessages,
}: DbSessionWorkspacePanelProps) {
  const displayRows = ws.result?.rows.slice(0, resultsDisplayCap) ?? []
  const hiddenRowCount =
    ws.result && ws.result.rows.length > resultsDisplayCap
      ? ws.result.rows.length - resultsDisplayCap
      : 0

  return (
    <div
      className={`dbw-session-panel${isActive ? ' active' : ''}`}
      aria-hidden={!isActive}
    >
      <div className="dbw-sidebar">
        <div className="dbw-sidebar-header">
          <span className="dbw-sidebar-title">{dbName}</span>
          <span className="dbw-sidebar-count">
            {ws.tablesLoading && ws.tables.length > 0
              ? 'Refreshing…'
              : `${ws.tables.length} table${ws.tables.length !== 1 ? 's' : ''}`}
          </span>
        </div>

        <div className="dbw-sidebar-list">
          {ws.tablesError ? (
            <div className="dbw-sidebar-error">
              <div>{ws.tablesError}</div>
              <button type="button" className="btn btn-sm" onClick={onFetchTables}>
                Retry
              </button>
            </div>
          ) : ws.tablesLoading && ws.tables.length === 0 ? (
            <div className="dbw-sidebar-loading">Loading tables...</div>
          ) : ws.tables.length === 0 ? (
            <div className="dbw-sidebar-empty">
              {ws.tablesLoading ? 'Loading tables...' : 'No tables found'}
            </div>
          ) : (
            ws.tables.map((t) => {
              const isExpanded = ws.expandedTable === t.name
              const cols = ws.tableColumns[t.name]
              const isLoadingCols = ws.columnsLoading === t.name
              const columnsErr = ws.columnsError[t.name]
              const columnsMissing = isExpanded && !isLoadingCols && cols === undefined

              return (
                <div key={t.name} className="dbw-table-node">
                  <div className="dbw-table-row">
                    <button
                      className={`dbw-table-expand ${isExpanded ? 'expanded' : ''}`}
                      onClick={() => onToggleTable(t.name)}
                      title="Show columns"
                    >
                      &#9656;
                    </button>
                    <button
                      className="dbw-table-name"
                      onClick={() => onTableClick(t.name)}
                      title={`SELECT * FROM ${t.name} LIMIT ${tablePreviewLimit}`}
                    >
                      {t.name}
                    </button>
                    {t.type === 'VIEW' && <span className="dbw-table-badge">VIEW</span>}
                  </div>

                  {isExpanded && (
                    <div className="dbw-columns-list">
                      {isLoadingCols ? (
                        <div className="dbw-col-loading">Loading...</div>
                      ) : cols ? (
                        cols.length === 0 ? (
                          <div className="dbw-col-empty">No columns</div>
                        ) : (
                          cols.map((col) => (
                            <div key={col.name} className="dbw-col-row">
                              <span
                                className={`dbw-col-key ${col.key === 'PRI' ? 'pk' : col.key === 'MUL' ? 'idx' : ''}`}
                              >
                                {col.key === 'PRI' ? '\u{1D4C}' : col.key === 'MUL' ? '\u25CB' : '\u2500'}
                              </span>
                              <span className="dbw-col-name">{col.name}</span>
                              <span className="dbw-col-type">{col.type}</span>
                            </div>
                          ))
                        )
                      ) : columnsMissing ? (
                        <div className="dbw-col-error">
                          <span className="dbw-col-error-text">
                            {columnsErr ? 'Couldn\u2019t load columns' : 'Columns not loaded'}
                          </span>
                          {columnsErr && (
                            <span className="dbw-col-error-detail" title={columnsErr}>
                              {columnsErr}
                            </span>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm dbw-col-retry-btn"
                            onClick={() => onRetryColumns(t.name)}
                          >
                            Retry
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className="dbw-right">
        <div className="dbw-editor-panel">
          <div className="dbw-editor-toolbar">
            <span className="dbw-editor-label">SQL Editor</span>
            <span className="dbw-editor-hint">
              <kbd className="kbd">&#8984;</kbd>
              <span className="kbd-plus">+</span>
              <kbd className="kbd">Enter</kbd>
              <span className="dbw-hint-text">to run</span>
            </span>
            <button
              className="btn btn-sm btn-primary dbw-run-btn"
              type="button"
              onClick={() => void onRunQuery()}
              disabled={ws.queryRunning || !ws.query.trim()}
            >
              {ws.queryRunning ? 'Running...' : 'Run \u25B6'}
            </button>
            {ws.queryRunning && (
              <button
                className="btn btn-sm dbw-cancel-btn"
                type="button"
                onClick={() => void onCancelQuery()}
              >
                Cancel
              </button>
            )}
          </div>
          <div className="dbw-editor-wrapper">
            <CodeMirror
              value={ws.query}
              onChange={onQueryChange}
              extensions={cmExtensions}
              theme="dark"
              height="100%"
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                autocompletion: true,
                highlightActiveLine: true,
                bracketMatching: true,
                closeBrackets: true,
              }}
            />
          </div>
        </div>

        <div className="dbw-results-panel">
          <div className="dbw-results-toolbar">
            <div className="dbw-results-tabs">
              <button
                type="button"
                className={`dbw-results-tab ${ws.activeResultTab === 'results' ? 'active' : ''}`}
                onClick={() => onActiveResultTab('results')}
              >
                Results
              </button>
              <button
                type="button"
                className={`dbw-results-tab ${ws.activeResultTab === 'messages' ? 'active' : ''}`}
                onClick={() => onActiveResultTab('messages')}
              >
                Messages
                {ws.messages.length > 0 && (
                  <span className="dbw-msg-count">{ws.messages.length}</span>
                )}
              </button>
            </div>
            {ws.activeResultTab === 'results' && ws.result && !ws.result.error && (
              <span className="dbw-results-meta">
                {ws.result.rowCount} row{ws.result.rowCount !== 1 ? 's' : ''}
                {' \u00B7 '}
                {formatMs(ws.result.executionTimeMs)}
                {ws.result.affectedRows > 0 && ` \u00B7 ${ws.result.affectedRows} affected`}
              </span>
            )}
            {ws.activeResultTab === 'messages' && ws.messages.length > 0 && (
              <button type="button" className="btn btn-sm" onClick={onClearMessages}>
                Clear
              </button>
            )}
          </div>

          <div className="dbw-results-content">
            {ws.activeResultTab === 'results' ? (
              ws.queryRunning ? (
                <div className="dbw-results-loading">
                  <div className="dbw-connecting-spinner dbw-spinner-sm" />
                  <span>
                    Running
                    {queryElapsedSec > 0 ? ` (${queryElapsedSec}s)` : '…'}
                  </span>
                  {queryElapsedSec >= 8 && (
                    <span className="dbw-results-loading-hint">
                      Still waiting on the SSH tunnel — use Cancel above, or try fewer columns / a
                      smaller LIMIT.
                    </span>
                  )}
                </div>
              ) : ws.result?.error ? (
                <div className="dbw-results-error">
                  <span className="dbw-error-icon">!</span>
                  <pre>{ws.result.error}</pre>
                </div>
              ) : ws.result && ws.result.columns.length > 0 ? (
                <>
                  <div className="dbw-table-scroll">
                    <table className="dbw-results-table">
                      <thead>
                        <tr>
                          <th className="dbw-row-num">#</th>
                          {ws.result.columns.map((col) => (
                            <th key={col.name}>
                              <span className="dbw-th-name">{col.name}</span>
                              <span className="dbw-th-type">{col.type}</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {displayRows.map((row, ri) => (
                          <tr key={ri}>
                            <td className="dbw-row-num">{ri + 1}</td>
                            {row.map((cell, ci) => (
                              <td key={ci}>{renderCellValue(cell)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {hiddenRowCount > 0 && (
                    <div className="dbw-results-display-cap">
                      Showing first {resultsDisplayCap.toLocaleString()} of{' '}
                      {ws.result.rows.length.toLocaleString()} rows — add LIMIT or WHERE to narrow
                      results.
                    </div>
                  )}
                </>
              ) : ws.result && ws.result.affectedRows > 0 ? (
                <div className="dbw-results-message-ok">
                  Query OK, {ws.result.affectedRows} row{ws.result.affectedRows !== 1 ? 's' : ''}{' '}
                  affected ({formatMs(ws.result.executionTimeMs)})
                </div>
              ) : !ws.result ? (
                <div className="dbw-results-empty">Run a query to see results here</div>
              ) : (
                <div className="dbw-results-empty">
                  Query returned no rows ({formatMs(ws.result.executionTimeMs)})
                </div>
              )
            ) : (
              <div className="dbw-messages-list">
                {ws.messages.length === 0 ? (
                  <div className="dbw-results-empty">No messages</div>
                ) : (
                  ws.messages.map((msg, i) => (
                    <div
                      key={i}
                      className={`dbw-message-item ${/^Error|^Query failed/i.test(msg) ? 'error' : ''}`}
                    >
                      {msg}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function panelPropsEqual(
  prev: DbSessionWorkspacePanelProps,
  next: DbSessionWorkspacePanelProps,
): boolean {
  return (
    prev.sessionId === next.sessionId &&
    prev.isActive === next.isActive &&
    prev.workspace === next.workspace &&
    prev.queryElapsedSec === next.queryElapsedSec &&
    prev.cmExtensions === next.cmExtensions &&
    prev.tablePreviewLimit === next.tablePreviewLimit &&
    prev.resultsDisplayCap === next.resultsDisplayCap
  )
}

export const DbSessionWorkspacePanel = memo(DbSessionWorkspacePanelInner, panelPropsEqual)
