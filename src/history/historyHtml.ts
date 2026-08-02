// History webview HTML builders + persisted UI state.
//
// Produces the full HTML document for the bottom-panel history view: the commit
// graph table, file/diff panes, and toolbar. Also persists the small UI state
// (graph position, bottom pane size) per workspace. Depends only on the graph
// renderer and HTML escaping.

import * as vscode from 'vscode';
import { escapeHtml } from '../shared/html';
import { getDict, Lang, resolveLang, t } from '../shared/i18n';
import { CommitData, RowLayout, renderCommitRows } from './graph';

export interface HistoryUiState {
    bottomFlex?: string; // CSS flex-basis value e.g. "240px"
}

const HISTORY_UI_STATE_KEY = 'gitBranches.historyUiState';
export function readHistoryUiState(context: vscode.ExtensionContext): HistoryUiState {
    return context.workspaceState.get<HistoryUiState>(HISTORY_UI_STATE_KEY, {});
}
export function writeHistoryUiState(context: vscode.ExtensionContext, patch: Partial<HistoryUiState>): Thenable<void> {
    const current = readHistoryUiState(context);
    return context.workspaceState.update(HISTORY_UI_STATE_KEY, { ...current, ...patch });
}

// Shown in the bottom-panel history view before any branch has been selected.
export function placeholderHistoryHtml(cspSource: string, lang: Lang = 'en'): string {
    const csp = `default-src 'none'; style-src ${cspSource} 'unsafe-inline';`;
    const L = getDict(lang);
    const t0 = (k: string) => L[k] ?? k;
    return `<!DOCTYPE html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
html, body { height: 100%; margin: 0; }
body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-editor-background);
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; text-align: center; padding: 24px; line-height: 1.6;
}
strong { color: var(--vscode-foreground); }
</style></head>
<body><div>${t0('empty.noBranch')}<br>${t0('empty.rightClickHint')}</div></body></html>`;
}

// Shown when loading a branch's history fails (mirrors the previous panel.dispose() error path).
export function errorHistoryHtml(cspSource: string, message: string): string {
    const csp = `default-src 'none'; style-src ${cspSource} 'unsafe-inline';`;
    return `<!DOCTYPE html><html lang="${resolveLang(vscode.env.language)}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
html, body { height: 100%; margin: 0; }
body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-errorForeground);
    background: var(--vscode-editor-background);
    font-size: 12px; padding: 16px; white-space: pre-wrap; word-break: break-word;
}
</style></head>
<body>Failed to load history:\n${escapeHtml(message)}</body></html>`;
}

export function buildHistoryHtml(
    commits: CommitData[], layouts: RowLayout[], ref: string, cspSource: string,
    svgWidth: number, hasMore: boolean, scope: string, branches: string[],
    allSentinel: string, ui: HistoryUiState, allowReset: boolean, filePath: string | undefined,
    lang: Lang,
): string {
    const rows = renderCommitRows(commits, layouts, svgWidth);
    const L = getDict(lang);
    const T = (k: string, ...a: (string | number)[]) => {
        let s = L[k] ?? k;
        a.forEach((x, i) => { s = s.replace(new RegExp(`\\{${i}\\}`, 'g'), String(x)); });
        return s;
    };
    const htmlLang = lang === 'zh' ? 'zh-CN' : 'en';

    const csp = `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:;`;

    return `<!DOCTYPE html><html lang="${htmlLang}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-editor-font-family, 'SF Mono', Menlo, Consolas, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex; flex-direction: row;
    -webkit-user-select: none; user-select: none;
  }
  .top { flex: 1 1 60%; overflow: auto; min-width: 240px; }
  .splitter {
    flex: 0 0 5px; cursor: col-resize;
    background: var(--vscode-panel-border);
    user-select: none;
  }
  .splitter:hover { background: var(--vscode-focusBorder, #007fd4); }
  .bottom {
    flex: 0 0 30%; min-width: 220px; max-width: 70%;
    display: flex; flex-direction: column;
    overflow: hidden;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-left: 1px solid var(--vscode-panel-border);
  }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    padding: 6px 14px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 12px; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.03em;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  .control-group { display: inline-flex; align-items: center; gap: 8px; }
  .control-group-right { margin-left: auto; }
  .branch-select {
    background: var(--vscode-input-background, var(--vscode-editor-background));
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    font-family: inherit; font-size: 12px; font-weight: 600;
    padding: 2px 6px;
    max-width: 360px;
    cursor: pointer;
  }
  .branch-select:focus {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 0;
  }
  .history-search {
    margin-left: auto;
    background: var(--vscode-input-background, var(--vscode-editor-background));
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    font-family: inherit; font-size: 12px; font-weight: 400;
    padding: 2px 8px;
    width: 240px; min-width: 120px;
    letter-spacing: 0;
    -webkit-user-select: text; user-select: text;
  }
  .history-search:focus {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 0;
  }
  tr.commit-row.filtered-out { display: none; }

  /* Right-click context menu (custom — VS Code's webview default is minimal) */
  .ctx-menu {
    position: fixed; display: none; z-index: 100;
    min-width: 220px; padding: 4px 0;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0,0,0,.3);
    font-size: 12px;
    user-select: none;
  }
  .ctx-menu .item {
    padding: 4px 16px; cursor: pointer; white-space: nowrap;
  }
  .ctx-menu .item:hover {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
  }
  .ctx-menu .item.danger { color: var(--vscode-errorForeground, #cb2431); }
  .ctx-menu .item.disabled { opacity: 0.45; cursor: default; }
  .ctx-menu .item.disabled:hover { background: transparent; color: var(--vscode-menu-foreground, var(--vscode-foreground)); }
  .ctx-menu .sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }

  .toolbar-title { color: var(--vscode-descriptionForeground); }
  .toolbar-title > span { color: var(--vscode-foreground); }
  .file-chip {
    display: inline-flex; align-items: center; gap: 6px;
    max-width: 320px; padding: 0 2px 0 8px; margin-left: 2px;
    border-radius: 11px;
    background: var(--vscode-badge-background, rgba(128,128,128,.18));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
    font-size: 11px; line-height: 20px;
  }
  .file-chip-pre { color: var(--vscode-descriptionForeground); }
  .file-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-chip-clear {
    border: none; background: transparent; cursor: pointer; color: inherit;
    font-size: 14px; line-height: 1; padding: 2px 5px; border-radius: 8px; opacity: .65;
  }
  .file-chip-clear:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.25)); }
  .control-label {
    color: var(--vscode-descriptionForeground);
    font-weight: 500; font-size: 11px;
    letter-spacing: 0.02em;
  }
  .pill-switch {
    display: inline-flex;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 999px;
    overflow: hidden;
    background: var(--vscode-editor-background);
  }
  .pill-switch button {
    background: transparent; color: var(--vscode-foreground);
    border: 0; border-left: 1px solid var(--vscode-panel-border);
    padding: 2px 14px; font-size: 11px; line-height: 18px; font-weight: 500;
    cursor: pointer; font-family: inherit; letter-spacing: 0;
  }
  .pill-switch button:first-child { border-left: 0; }
  .pill-switch button:hover:not(.active):not(:disabled) { background: var(--vscode-list-hoverBackground); }
  .pill-switch button.active {
    background: var(--vscode-button-background, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-button-foreground, var(--vscode-list-activeSelectionForeground));
    cursor: default;
  }
  .pill-switch button:disabled { opacity: 0.6; cursor: wait; }
  table { border-collapse: collapse; width: max-content; min-width: 100%; }
  thead th {
    position: sticky; top: 38px; z-index: 9;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    padding: 4px 10px;
    text-align: left; font-size: 11px; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.06em; text-transform: uppercase;
    white-space: nowrap;
  }
  td { padding: 2px 10px; white-space: nowrap; vertical-align: middle; }
  tr.commit-row { cursor: pointer; }
  tr.commit-row:hover td { background: var(--vscode-list-hoverBackground); }
  tr.commit-row.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  tr.commit-row td { user-select: none; }
  /* Graph column: cap width so very-wide lane diagrams don't push subject/date off-screen;
     SVG inside scrolls horizontally if it exceeds the cap. */
  .col-graph {
    padding-left: 6px; padding-right: 4px;
    max-width: 200px; overflow-x: auto; overflow-y: hidden;
  }
  .col-graph::-webkit-scrollbar { height: 4px; }
  .col-graph::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,.3)); }
  #graph-th { max-width: 200px; }

  .col-hash   { color: #e5c07b; font-weight: bold; min-width: 7ch; }
  .col-refs   { min-width: 80px; max-width: 220px; }
  .col-refs .refs-inner { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .col-subject{ max-width: 400px; overflow: hidden; text-overflow: ellipsis; }
  .col-date   { color: var(--vscode-descriptionForeground); min-width: 100px; text-align: right; padding-right: 14px; }
  .col-author { color: #61afef; min-width: 100px; }
  .ref-pill {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 0 5px; margin-right: 3px;
    border-radius: 8px;
    font-size: 10px; line-height: 14px; height: 14px;
    vertical-align: middle;
    max-width: 110px;
    border: 1px solid transparent;
  }
  .ref-pill > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ref-icon { flex: 0 0 auto; opacity: 0.85; }
  .ref-head   { background: rgba(86,182,194,.18);  color: #56b6c2; border-color: rgba(86,182,194,.35); font-weight: 600; }
  .ref-local  { background: rgba(152,195,121,.18); color: #98c379; border-color: rgba(152,195,121,.30); }
  .ref-remote { background: rgba(224,108,117,.16); color: #e06c75; border-color: rgba(224,108,117,.28); }
  .ref-tag    { background: rgba(229,192,123,.18); color: #e5c07b; border-color: rgba(229,192,123,.35); }

  .files-toolbar {
    position: sticky; top: 0; z-index: 5;
    padding: 6px 14px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 11px; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.05em; text-transform: uppercase;
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 0 0 auto;
  }
  /* Wrap the right-side actions (export / view toggle) onto their own line */
  .files-actions {
    display: flex; align-items: center; gap: 8px;
    flex-basis: 100%; margin-top: 2px;
  }
  .files-toolbar .commit-info {
    text-transform: none; letter-spacing: 0;
    font-weight: normal; color: var(--vscode-foreground);
    flex: 1 1 auto; min-width: 0; display: flex; align-items: center;
    overflow: hidden; white-space: nowrap;
  }
  .files-toolbar .commit-info .subject {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  .files-toolbar .commit-info .hash { color: #e5c07b; font-weight: bold; margin-right: 6px; flex: 0 0 auto; }
  .files-empty {
    padding: 14px; color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }
  #files { flex: 1 1 auto; overflow: auto; min-height: 0; }
  .file-row {
    display: flex; align-items: center; gap: 8px;
    padding: 3px 14px; cursor: pointer;
    white-space: nowrap;
    width: max-content; min-width: 100%;
  }
  .file-row:hover { background: var(--vscode-list-hoverBackground); }
  .file-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .file-row .status {
    flex: 0 0 16px;
    text-align: center;
    font-weight: bold;
    font-size: 11px;
    border-radius: 3px;
    padding: 0 4px;
    line-height: 16px;
    color: #fff;
  }
  .file-row .status.A { background: #28a745; }
  .file-row .status.M { background: #d29922; }
  .file-row .status.D { background: #cb2431; }
  .file-row .status.R { background: #6f42c1; }
  .file-row .status.C { background: #6f42c1; }
  .file-row .status.T { background: #586069; }
  .file-row .dir  { color: var(--vscode-descriptionForeground); }
  .file-row .rename-from { color: var(--vscode-descriptionForeground); margin-right: 4px; }

  .load-more {
    padding: 10px 14px 24px;
    text-align: center;
  }
  .load-more button {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border);
    padding: 5px 18px;
    border-radius: 3px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
  }
  .load-more button:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  }
  .load-more button:disabled {
    opacity: 0.5; cursor: default;
  }
  .load-more .end-marker {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }

  /* Files-toolbar view toggle (list ↔ inline diff) */
  .view-toggle {
    margin-left: 0;
    display: inline-flex;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 999px; overflow: hidden;
    background: var(--vscode-editor-background);
    text-transform: none; letter-spacing: 0;
  }
  .view-toggle button {
    background: transparent; color: var(--vscode-foreground);
    border: 0; border-left: 1px solid var(--vscode-panel-border);
    padding: 2px 12px; font-size: 11px; line-height: 18px; font-weight: 500;
    cursor: pointer; font-family: inherit; letter-spacing: 0;
  }
  .view-toggle button:first-child { border-left: 0; }
  .view-toggle button.active {
    background: var(--vscode-button-background, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-button-foreground, var(--vscode-list-activeSelectionForeground));
    cursor: default;
  }

  /* Export patch button on the Files Changed title bar */
  .export-patch-btn {
    margin-left: 0;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border);
    padding: 2px 10px; border-radius: 3px;
    font-size: 11px; line-height: 18px; font-weight: 500;
    cursor: pointer; font-family: inherit;
  }
  .export-patch-btn:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  }
  .export-patch-btn:disabled { opacity: 0.45; cursor: default; }

  /* ---- Inline side-by-side commit diff (double-click a commit) ---- */
  .inline-diff .file { border-bottom: 8px solid var(--vscode-panel-border, #333); }
  .inline-diff .file-head {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 8px;
    padding: 5px 12px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-top: 1px solid var(--vscode-panel-border);
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .inline-diff .file-head .status {
    flex: 0 0 auto; font-weight: 700; font-size: 11px;
    border-radius: 3px; padding: 0 6px; line-height: 16px; color: #fff;
  }
  .inline-diff .file-head .status.A { background: #28a745; }
  .inline-diff .file-head .status.M { background: #d29922; }
  .inline-diff .file-head .status.D { background: #cb2431; }
  .inline-diff .file-head .status.R { background: #6f42c1; }
  .inline-diff .file-head .status.C { background: #6f42c1; }
  .inline-diff .file-head .status.T { background: #586069; }
  .inline-diff .file-head .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inline-diff .file-head .dir { color: var(--vscode-descriptionForeground); }
  .inline-diff .file-head .old { color: var(--vscode-descriptionForeground); }
  .inline-diff .hunk { margin: 0; }
  .inline-diff .hunk-head {
    padding: 2px 12px; color: var(--vscode-descriptionForeground); font-size: 11px;
    background: var(--vscode-sideBar-background, rgba(128,128,128,.06));
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .inline-diff table.diff { border-collapse: collapse; width: 100%; table-layout: fixed; }
  .inline-diff table.diff td { padding: 0; vertical-align: top; width: 50%; }
  .inline-diff .line { display: flex; align-items: stretch; }
  .inline-diff .gutter {
    flex: 0 0 48px; width: 48px; min-width: 48px; text-align: right; padding: 0 6px;
    color: var(--vscode-descriptionForeground); user-select: none;
    border-right: 1px solid var(--vscode-panel-border); font-size: 11px;
  }
  .inline-diff .code {
    flex: 1 1 auto; min-width: 0; padding: 0 8px; white-space: pre-wrap; word-break: break-all;
    font-family: var(--vscode-editor-font-family, 'SF Mono', Menlo, Consolas, monospace); tab-size: 4; overflow-wrap: anywhere;
    -webkit-user-select: text; user-select: text;
  }
  .inline-diff .col-left { border-right: 1px solid var(--vscode-panel-border); }
  .inline-diff td.del .code { background: rgba(224,108,117,.16); }
  .inline-diff td.del .gutter { background: rgba(224,108,117,.10); }
  .inline-diff td.add .code { background: rgba(152,195,121,.16); }
  .inline-diff td.add .gutter { background: rgba(152,195,121,.10); }
  .inline-diff td.empty .code { background: rgba(128,128,128,.05); }
  .inline-diff .bin { padding: 8px 12px; color: var(--vscode-descriptionForeground); font-style: italic; }
  .inline-diff .empty-diff { padding: 14px 12px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div class="top">
  <div class="toolbar">
    <span class="toolbar-title">${T('toolbar.title')}</span>
    <select class="branch-select" id="branch-select" title="${T('toolbar.branchTitle')}">
      ${(() => {
        // Top entry: the ref the user opened from (always shown, even if remote)
        const opts: string[] = [];
        const seen = new Set<string>();
        opts.push(`<option value="${escapeHtml(ref)}"${scope === ref ? ' selected' : ''}>${escapeHtml(ref)}</option>`);
        seen.add(ref);
        for (const b of branches) {
          if (seen.has(b)) { continue; }
          seen.add(b);
          opts.push(`<option value="${escapeHtml(b)}"${scope === b ? ' selected' : ''}>${escapeHtml(b)}</option>`);
        }
        opts.push(`<option value="${escapeHtml(allSentinel)}"${scope === allSentinel ? ' selected' : ''}>-- ALL --</option>`);
        return opts.join('\n      ');
      })()}
    </select>
    ${filePath ? (() => {
        const short = filePath.split('/').pop() || filePath;
        return `<span class="file-chip" title="${T('toolbar.fileChipTitle', escapeHtml(filePath))}"><span class="file-chip-pre">Path</span><span class="file-chip-label">${escapeHtml(short)}</span><button type="button" class="file-chip-clear" id="clear-file" title="${T('toolbar.fileChipClear')}" aria-label="${T('toolbar.fileChipClearAria')}">×</button></span>`;
    })() : ''}
    <input type="search" class="history-search" id="history-search" placeholder="${T('toolbar.searchPlaceholder')}" autocomplete="off" spellcheck="false" />
  </div>
  <table>
    <thead>
      <tr>
        <th id="graph-th" style="min-width:${svgWidth + 16}px"></th>
        <th>${T('table.hash')}</th>
        <th>${T('table.message')}</th>
        <th>${T('table.author')}</th>
        <th style="text-align:right;padding-right:14px">${T('table.date')}</th>
        <th>${T('table.refs')}</th>
      </tr>
    </thead>
    <tbody id="commits">${rows}</tbody>
  </table>
  <div class="load-more" id="load-more">
    ${hasMore
      ? `<button id="load-more-btn">${T('btn.loadMore', commits.length)}</button>`
      : `<span class="end-marker">${T('loadMore.end', commits.length)}</span>`}
  </div>
</div>
<div class="splitter" id="splitter"></div>
<div class="bottom"${ui.bottomFlex ? ` style="flex-basis:${escapeHtml(ui.bottomFlex)};"` : ''}>
  <div class="files-toolbar">
    <span>${T('toolbar.filesChanged')}</span>
    <span class="commit-info" id="commit-info"></span>
    <div class="files-actions">
      <button type="button" class="export-patch-btn" id="export-patch" title="${T('toolbar.exportPatchTitle')}" disabled>${T('toolbar.exportPatch')}</button>
      <div class="view-toggle" id="view-toggle">
        <button type="button" data-view="diff">${T('toolbar.viewDiff')}</button>
      </div>
    </div>
  </div>
  <div id="files"><div class="files-empty">${T('empty.selectCommit')}</div></div>
</div>

<div class="ctx-menu" id="commit-ctx-menu">
  <div class="item" data-action="copyHash">${T('menu.copyHash')}</div>
  <div class="item" data-action="copyShortHash">${T('menu.copyShortHash')}</div>
  <div class="item" data-action="copySubject">${T('menu.copySubject')}</div>
  <div class="sep"></div>
  <div class="item" data-action="checkout">${T('menu.checkout')}</div>
  <div class="item" data-action="createBranch">${T('menu.createBranch')}</div>
  <div class="item" data-action="cherryPick">${T('menu.cherryPick')}</div>
  <div class="item" data-action="revert">${T('menu.revert')}</div>
  <div class="item" data-action="compareWorktree">${T('menu.compareWorktree')}</div>
  <div class="sep"></div>
  <div class="item${allowReset ? '' : ' disabled'}" data-action="resetSoft">${T('menu.resetSoft')}${allowReset ? '' : ' ' + T('menu.resetCurrentBranchOnly')}</div>
  <div class="item danger${allowReset ? '' : ' disabled'}" data-action="resetHard">${T('menu.resetHard')}${allowReset ? '' : ' ' + T('menu.resetCurrentBranchOnly')}</div>
  <div class="sep"></div>
  <div class="item" data-action="exportPatch">${T('menu.exportPatch')}</div>
  <div class="item" data-action="openInBrowser">${T('menu.openInBrowser')}</div>
</div>

<div class="ctx-menu" id="multi-ctx-menu">
  <div class="item" data-action="exportPatch">${T('menu.exportOnePatch')}</div>
  <div class="item" data-action="copyHashes">${T('menu.copyHashes')}</div>
</div>

<div class="ctx-menu" id="file-ctx-menu">
  <div class="item" data-action="getFile">${T('menu.getFile')}</div>
  <div class="sep"></div>
  <div class="item" data-action="compareWorktree">${T('menu.compareWorktree')}</div>
</div>

<script>
(function () {
  const vscode = acquireVsCodeApi();

  // The full dictionary is embedded inline at build time (host-side getDict),
  // so runtime (dynamically generated) fragments localize correctly without
  // depending on the postMessage timing. The host may still push an updated
  // dict on language change, which simply overwrites this one.
  let i18n = ${JSON.stringify(getDict(lang))};
  function t(key) { return i18n[key] ?? key; }

  const commitsEl = document.getElementById('commits');
  const filesEl = document.getElementById('files');
  const infoEl = document.getElementById('commit-info');
  // Keep the inline-diff file headers docked *below* the sticky files-toolbar
  // (which shows the commit message) so a long message never overlaps the diff.
  const filesToolbarEl = document.querySelector('.files-toolbar');
  function syncToolbarHeight() {
    if (filesToolbarEl) {
      document.documentElement.style.setProperty('--toolbar-h', filesToolbarEl.offsetHeight + 'px');
    }
  }
  syncToolbarHeight();
  window.addEventListener('resize', syncToolbarHeight);

  // Keep the sticky commit-table header flush under the top toolbar.
  // The toolbar height varies (it can wrap), so hard-coding the header's
  // top value left a 1px gap above the header — measure it live instead.
  function syncHeaderTop() {
    const tb = document.querySelector('.top .toolbar');
    const ths = document.querySelectorAll('thead th');
    if (tb && ths.length) {
      const h = tb.offsetHeight;
      ths.forEach(t => { t.style.top = h + 'px'; });
    }
  }
  syncHeaderTop();
  window.addEventListener('resize', syncHeaderTop);
  // Re-sync after the table is rebuilt by the host (e.g. scope change).
  const historyRoot = document.getElementById('history');
  if (historyRoot) {
    const mo = new MutationObserver(syncHeaderTop);
    mo.observe(historyRoot, { childList: true, subtree: true });
  }
  let currentHash = null;
  let currentParent = null;
  let currentDisplay = null;
  let currentSubject = null;
  let viewMode = 'list'; // 'list' (file picker) | 'diff' (inline side-by-side)
  let compareWorktree = false; // when true, file clicks diff the commit against the live working tree

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function splitPath(p) {
    const i = p.lastIndexOf('/');
    if (i === -1) { return { dir: '', name: p }; }
    return { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
  }

  function renderFiles(files) {
    if (!files.length) {
      filesEl.innerHTML = '<div class="files-empty">' + t('empty.noFiles') + '</div>';
      return;
    }
    filesEl.innerHTML = files.map(f => {
      const sp = splitPath(f.path);
      const rename = (f.status === 'R' || f.status === 'C') && f.oldPath
        ? '<span class="rename-from">' + escapeHtml(f.oldPath) + ' →</span>'
        : '';
      return '<div class="file-row" data-path="' + escapeHtml(f.path) + '" data-old="' + escapeHtml(f.oldPath || '') + '" data-status="' + escapeHtml(f.status) + '">' +
        '<span class="status ' + escapeHtml(f.status) + '">' + escapeHtml(f.status) + '</span>' +
        rename +
        '<span class="path"><span class="dir">' + escapeHtml(sp.dir) + '</span>' + escapeHtml(sp.name) + '</span>' +
      '</div>';
    }).join('');
  }

  function setViewMode(mode) {
    viewMode = mode;
    const btns = document.querySelectorAll('#view-toggle button');
    btns.forEach(b => b.classList.toggle('active', b.dataset.view === mode));
  }

  // Inline side-by-side diff for a single commit (double-click a row).
  // Left column = parent (old), right column = commit (latest code); only changed hunks are shown.
  function diffHunkRows(hunk) {
    const rows = [];
    let li = hunk.leftStart, ri = hunk.rightStart;
    let lb = [], rb = [];
    function flush() {
      const n = Math.max(lb.length, rb.length);
      for (let k = 0; k < n; k++) { rows.push({ l: lb[k] || null, r: rb[k] || null }); }
      lb = []; rb = [];
    }
    for (const ln of hunk.lines) {
      if (ln.type === ' ') { flush(); rows.push({ l: { no: li++, text: ln.text, kind: 'ctx' }, r: { no: ri++, text: ln.text, kind: 'ctx' } }); }
      else if (ln.type === '-') { lb.push({ no: li++, text: ln.text, kind: 'del' }); }
      else { rb.push({ no: ri++, text: ln.text, kind: 'add' }); }
    }
    flush();
    return rows;
  }
  function renderDiffHunk(file, hunk) {
    const rows = diffHunkRows(hunk);
    const rowsHtml = rows.map(r => {
      const L = r.l, R = r.r;
      const td = (c, no, t) => '<td class="' + c + '"><div class="line"><div class="gutter">' + no + '</div><div class="code">' + escapeHtml(t) + '</div></div></td>';
      if (L && R) { return '<tr>' + td(L.kind, L.no, L.text) + td(R.kind, R.no, R.text) + '</tr>'; }
      if (L) { return '<tr>' + td(L.kind, L.no, L.text) + '<td class="empty"><div class="line"><div class="gutter"></div><div class="code"></div></div></td></tr>'; }
      return '<tr><td class="empty"><div class="line"><div class="gutter"></div><div class="code"></div></div></td>' + td(R.kind, R.no, R.text) + '</tr>';
    }).join('');
    const isRename = (file.status === 'R' || file.status === 'C') && file.oldPath;
    const head = isRename
      ? escapeHtml(file.oldPath) + ' → ' + escapeHtml(file.path)
      : '@@ -' + hunk.leftStart + ',' + hunk.leftCount + ' +' + hunk.rightStart + ',' + hunk.rightCount + ' @@';
    return '<div class="hunk"><div class="hunk-head"><span>' + head + '</span></div><table class="diff">' + rowsHtml + '</table></div>';
  }
  function renderDiffFile(file) {
    const sp = splitPath(file.path);
    let body;
    if (file.binary) { body = '<div class="bin">二进制文件不同（无法内联显示）</div>'; }
    else if (!file.hunks.length) { body = '<div class="empty-diff">无文本差异</div>'; }
    else { body = file.hunks.map(h => renderDiffHunk(file, h)).join(''); }
    const rename = (file.status === 'R' || file.status === 'C') && file.oldPath
      ? '<span class="old">' + escapeHtml(file.oldPath) + ' → </span>' : '';
    return '<div class="file"><div class="file-head">' +
      '<span class="status ' + escapeHtml(file.status) + '">' + escapeHtml(file.status) + '</span>' +
      rename +
      '<span class="name"><span class="dir">' + escapeHtml(sp.dir) + '</span>' + escapeHtml(sp.name) + '</span>' +
      '</div>' + body + '</div>';
  }
  function renderCommitDiff(files) {
    if (!files || !files.length) { filesEl.innerHTML = '<div class="files-empty">' + t('empty.noFiles') + '</div>'; return; }
    filesEl.innerHTML = '<div class="inline-diff">' + files.map(renderDiffFile).join('') + '</div>';
  }

  // Selection state — multi-select: plain click = single, ctrl/cmd+click = toggle, shift+click = contiguous range.
  let anchorRow = null; // last explicitly-clicked row, used as shift-range anchor
  let rangeMode = false;
  let rangeFrom = null; // older hash (left side of diff)
  let rangeTo = null;   // newer hash (right side of diff)

  function allRows() {
    return Array.from(commitsEl.querySelectorAll('tr.commit-row'));
  }
  function visibleRows() {
    return allRows().filter(r => !r.classList.contains('filtered-out'));
  }
  function selectedRows() {
    // DOM order: index 0 = newest (topo-order).
    return allRows().filter(r => r.classList.contains('selected'));
  }
  function clearSelection() {
    selectedRows().forEach(r => r.classList.remove('selected'));
    rangeMode = false;
    rangeFrom = null;
    rangeTo = null;
  }

  function updateDetailsFromSelection() {
    const sel = selectedRows();
    rangeMode = false;
    rangeFrom = null;
    rangeTo = null;
    if (sel.length === 0) {
      currentHash = null;
      currentParent = null;
      infoEl.textContent = '';
      filesEl.innerHTML = '<div class="files-empty">' + t('empty.selectCommit') + '</div>';
      refreshExportButton();
      return;
    }
    if (sel.length === 1) {
      const row = sel[0];
      currentHash = row.dataset.hash;
      currentParent = row.dataset.parent || '';
      currentDisplay = row.dataset.display;
      currentSubject = row.dataset.subject;
      let info = '<span class="hash">' + escapeHtml(row.dataset.display) + '</span>';
      if (compareWorktree) {
        info += ' <span style="color:var(--vscode-charts-blue,#56b6c2);font-weight:600;">↔ 工作区</span>';
      }
      infoEl.innerHTML = info;
      setViewMode('list');
      filesEl.innerHTML = '<div class="files-empty">' + t('state.loading') + '</div>';
      if (compareWorktree) {
        // List the files that differ between this commit and the working tree.
        vscode.postMessage({ type: 'selectCommitWorktree', hash: currentHash });
      } else {
        vscode.postMessage({ type: 'selectCommit', hash: currentHash, parent: currentParent });
      }
      refreshExportButton();
      return;
    }
    // Multi-selection: show diff between the oldest and the newest selected commit.
    const newerRow = sel[0];
    const olderRow = sel[sel.length - 1];
    rangeMode = true;
    rangeFrom = olderRow.dataset.hash;
    rangeTo   = newerRow.dataset.hash;
    currentHash = null;
    currentParent = null;
    const shortFrom = (olderRow.dataset.display || rangeFrom.slice(0, 8));
    const shortTo   = (newerRow.dataset.display || rangeTo.slice(0, 8));
      infoEl.innerHTML =
      '<span class="hash">' + escapeHtml(shortFrom) + '..' + escapeHtml(shortTo) + '</span>' +
      sel.length + t('info.rangeDiff', sel.length);
    filesEl.innerHTML = '<div class="files-empty">' + t('state.loading') + '</div>';
    vscode.postMessage({ type: 'selectRange', fromHash: rangeFrom, toHash: rangeTo });
    refreshExportButton();
  }

  commitsEl.addEventListener('click', (e) => {
    const row = e.target.closest('tr.commit-row');
    if (!row) { return; }
    compareWorktree = false;
    const ctrl = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;

    if (shift && anchorRow && anchorRow !== row) {
      // Shift+click: select the contiguous (visible) range between anchor and this row.
      const rows = visibleRows();
      const a = rows.indexOf(anchorRow);
      const b = rows.indexOf(row);
      if (a !== -1 && b !== -1) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        if (!ctrl) { clearSelection(); }
        for (let i = lo; i <= hi; i++) { rows[i].classList.add('selected'); }
        updateDetailsFromSelection();
        return;
      }
    }

    if (ctrl) {
      // Ctrl/Cmd+click: toggle this row in/out of the selection.
      row.classList.toggle('selected');
      if (row.classList.contains('selected')) { anchorRow = row; }
      updateDetailsFromSelection();
      return;
    }

    // Plain click — single selection.
    clearSelection();
    row.classList.add('selected');
    anchorRow = row;
    updateDetailsFromSelection();
  });

  // Files-toolbar toggle: list (file picker) ↔ open diff in a new tab.
  const viewToggle = document.getElementById('view-toggle');
  if (viewToggle) {
    viewToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-view]');
      if (!btn) { return; }
      const mode = btn.dataset.view;
      if (mode === 'list') {
        setViewMode('list');
        if (currentHash && !rangeMode) {
          filesEl.innerHTML = '<div class="files-empty">' + t('state.loading') + '</div>';
          if (compareWorktree) {
            vscode.postMessage({ type: 'selectCommitWorktree', hash: currentHash });
          } else {
            vscode.postMessage({ type: 'selectCommit', hash: currentHash, parent: currentParent });
          }
        }
      } else if (mode === 'diff') {
        if (!currentHash || rangeMode) { return; }
        // Open the commit diff in its own tab instead of inline in this panel.
        // When in worktree-compare mode, carry that flag through so the new tab
        // diffs the commit against the live working tree (not its parent).
        vscode.postMessage({ type: 'openCommitDiffTab', hash: currentHash, parent: currentParent, display: currentDisplay, subject: currentSubject, compareWorktree: compareWorktree });
      }
    });
  }

  // Export Patch button on the Files Changed title bar.
  const exportPatchBtn = document.getElementById('export-patch');
  function refreshExportButton() {
    if (exportPatchBtn) {
      exportPatchBtn.disabled = !(currentHash || (rangeMode && rangeFrom && rangeTo));
    }
  }
  if (exportPatchBtn) {
    exportPatchBtn.addEventListener('click', () => {
      if (rangeMode && rangeFrom && rangeTo) {
        vscode.postMessage({ type: 'exportPatch', hashes: [rangeFrom, rangeTo] });
      } else if (currentHash) {
        if (compareWorktree) {
          // Working-tree comparison: export the diff between the commit and the live working tree.
          vscode.postMessage({ type: 'exportWorktreePatch', hash: currentHash });
        } else {
          vscode.postMessage({ type: 'exportPatch', hashes: [currentHash] });
        }
      }
    });
  }

  // File-row selection (single / ctrl-toggle / shift-range), mirroring the
  // commit-row model so files can be multi-selected and then right-clicked.
  let anchorFileRow = null;
  function selectedFileRows() {
    return Array.from(filesEl.querySelectorAll('.file-row.selected'));
  }
  function clearFileSelection() {
    selectedFileRows().forEach(r => r.classList.remove('selected'));
    anchorFileRow = null;
  }

  filesEl.addEventListener('click', (e) => {
    const row = e.target.closest('.file-row');
    if (!row) { return; }
    const ctrl = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;

    if (shift && anchorFileRow && anchorFileRow !== row) {
      const rows = Array.from(filesEl.querySelectorAll('.file-row'));
      const a = rows.indexOf(anchorFileRow);
      const b = rows.indexOf(row);
      if (a !== -1 && b !== -1) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        if (!ctrl) { clearFileSelection(); }
        for (let i = lo; i <= hi; i++) { rows[i].classList.add('selected'); }
        return; // range select: don't open a diff
      }
    }

    if (ctrl) {
      // Ctrl/Cmd+click: toggle this file in/out of the selection (no diff).
      row.classList.toggle('selected');
      if (row.classList.contains('selected')) { anchorFileRow = row; }
      return;
    }

    // Plain click — single selection + open diff (existing behavior).
    clearFileSelection();
    row.classList.add('selected');
    anchorFileRow = row;
    if (rangeMode && rangeFrom && rangeTo) {
      vscode.postMessage({
        type: 'openFile',
        fromHash: rangeFrom,
        toHash: rangeTo,
        status: row.dataset.status,
        path: row.dataset.path,
        oldPath: row.dataset.old || undefined,
      });
    } else if (currentHash) {
      vscode.postMessage({
        type: 'openFile',
        hash: currentHash,
        parent: currentParent,
        status: row.dataset.status,
        path: row.dataset.path,
        oldPath: row.dataset.old || undefined,
        compareWorktree: compareWorktree,
      });
    }
  });

  const loadMoreEl = document.getElementById('load-more');
  const graphTh = document.getElementById('graph-th');
  let loadedCount = commitsEl.querySelectorAll('tr.commit-row').length;

  function attachLoadMoreHandler() {
    const btn = document.getElementById('load-more-btn');
    if (!btn) { return; }
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = t('state.loading');
      vscode.postMessage({ type: 'loadMore', skip: loadedCount });
    });
  }
  attachLoadMoreHandler();

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type === 'i18n') {
      i18n = m.dict || {};
      return;
    }
    if (m?.type === 'files' && m.hash === currentHash && !rangeMode && viewMode === 'list') {
      if (m.error) {
        filesEl.innerHTML = '<div class="files-empty">' + escapeHtml(m.error) + '</div>';
      } else {
        renderFiles(m.files);
      }
    } else if (m?.type === 'commitDiff' && m.hash === currentHash && !rangeMode && viewMode === 'diff') {
      if (m.error) {
        filesEl.innerHTML = '<div class="files-empty">' + escapeHtml(m.error) + '</div>';
      } else {
        renderCommitDiff(m.files);
      }
    } else if (m?.type === 'rangeFiles' && rangeMode && m.fromHash === rangeFrom && m.toHash === rangeTo) {
      if (m.error) {
        filesEl.innerHTML = '<div class="files-empty">' + escapeHtml(m.error) + '</div>';
      } else {
        renderFiles(m.files);
      }
    } else if (m?.type === 'moreCommits') {
      // Append new rows
      const tmp = document.createElement('tbody');
      tmp.innerHTML = m.rowsHtml;
      while (tmp.firstChild) {
        commitsEl.appendChild(tmp.firstChild);
      }
      loadedCount += m.added;
      if (m.svgWidth && graphTh) {
        graphTh.style.minWidth = (m.svgWidth + 16) + 'px';
      }
      applySearchFilter();
      // Replace load-more area content
      if (m.hasMore) {
        loadMoreEl.innerHTML = '<button id="load-more-btn">Load more (' + loadedCount + ' loaded)</button>';
        attachLoadMoreHandler();
      } else {
        loadMoreEl.innerHTML = '<span class="end-marker">— end of history (' + loadedCount + ' commits) —</span>';
      }
    } else if (m?.type === 'loadMoreError') {
      const btn = document.getElementById('load-more-btn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Load more — retry (error: ' + (m.error || 'unknown') + ')';
      }
      if (branchSelect) { branchSelect.disabled = false; }
    } else if (m?.type === 'resetCommits') {
      // Scope changed — replace all rows, reset selection & file panel
      commitsEl.innerHTML = m.rowsHtml;
      loadedCount = m.loadedCount;
      anchorRow = null;
      currentHash = null;
      currentParent = null;
      compareWorktree = false;
      clearSelection();
      refreshExportButton();
      infoEl.textContent = '';
      filesEl.innerHTML = '<div class="files-empty">' + t('empty.selectCommit') + '</div>';
      if (m.svgWidth && graphTh) {
        graphTh.style.minWidth = (m.svgWidth + 16) + 'px';
      }
      // Sync dropdown to confirmed scope, re-enable it
      if (branchSelect) {
        if (branchSelect.value !== m.scope) { branchSelect.value = m.scope; }
        branchSelect.disabled = false;
      }
      // Reset load-more area
      if (m.hasMore) {
        loadMoreEl.innerHTML = '<button id="load-more-btn">Load more (' + loadedCount + ' loaded)</button>';
        attachLoadMoreHandler();
      } else {
        loadMoreEl.innerHTML = '<span class="end-marker">— end of history (' + loadedCount + ' commits) —</span>';
      }
      applySearchFilter();
      // Scroll to top of the table for the new scope
      const topPane = document.querySelector('.top');
      if (topPane) { topPane.scrollTop = 0; }
    }
  });

  // Branch dropdown — picks a local branch ref or the "-- ALL --" sentinel.
  const branchSelect = document.getElementById('branch-select');
  if (branchSelect) {
    branchSelect.addEventListener('change', () => {
      const newScope = branchSelect.value;
      branchSelect.disabled = true;
      vscode.postMessage({ type: 'setScope', scope: newScope });
    });
  }

  // File-scope chip — clear the file filter and return to full branch history.
  const clearFileBtn = document.getElementById('clear-file');
  if (clearFileBtn) {
    clearFileBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearFileScope' });
    });
  }

  // Search box — client-side filter over already-loaded commits.
  const searchInput = document.getElementById('history-search');
  let searchQuery = '';
  function applySearchFilter(rows) {
    const q = searchQuery.trim().toLowerCase();
    const targets = rows || commitsEl.querySelectorAll('tr.commit-row');
    if (!q) {
      targets.forEach(tr => tr.classList.remove('filtered-out'));
      return;
    }
    targets.forEach(tr => {
      const hash    = (tr.dataset.hash    || '').toLowerCase();
      const display = (tr.dataset.display || '').toLowerCase();
      const subject = (tr.dataset.subject || '').toLowerCase();
      const author  = (tr.dataset.author  || '').toLowerCase();
      const match = hash.includes(q) || display.includes(q) || subject.includes(q) || author.includes(q);
      tr.classList.toggle('filtered-out', !match);
    });
  }
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      applySearchFilter();
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { searchInput.value = ''; searchQuery = ''; applySearchFilter(); }
    });
  }

  // Right-click context menus (commit rows + file rows)
  const commitCtxMenu = document.getElementById('commit-ctx-menu');
  const multiCtxMenu = document.getElementById('multi-ctx-menu');
  const fileCtxMenu = document.getElementById('file-ctx-menu');
  let ctxTarget = null; // { kind: 'commit'|'multi'|'file', ... }

  function showCtxMenu(menu, x, y) {
    menu.style.display = 'block';
    // Position; clamp to viewport
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const px = Math.min(x, window.innerWidth - w - 4);
    const py = Math.min(y, window.innerHeight - h - 4);
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';
  }
  function hideCtxMenus() {
    commitCtxMenu.style.display = 'none';
    multiCtxMenu.style.display = 'none';
    fileCtxMenu.style.display = 'none';
    ctxTarget = null;
  }
  document.addEventListener('click', hideCtxMenus);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideCtxMenus(); } });
  window.addEventListener('blur', hideCtxMenus);

  commitsEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('tr.commit-row');
    if (!row) { return; }
    e.preventDefault();

    // If right-clicking a row outside the current selection, make it the sole selection.
    if (!row.classList.contains('selected')) {
      clearSelection();
      row.classList.add('selected');
      anchorRow = row;
      updateDetailsFromSelection();
    }

    const sel = selectedRows();
    if (sel.length > 1) {
      // Multi-selection menu (DOM order: index 0 = newest).
      ctxTarget = {
        kind: 'multi',
        hashes: sel.map(r => r.dataset.hash),
      };
      showCtxMenu(multiCtxMenu, e.clientX, e.clientY);
      return;
    }

    ctxTarget = {
      kind: 'commit',
      hash: row.dataset.hash,
      parent: row.dataset.parent || '',
      subject: row.dataset.subject || '',
      display: row.dataset.display || '',
    };
    showCtxMenu(commitCtxMenu, e.clientX, e.clientY);
  });

  commitCtxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item || !ctxTarget || ctxTarget.kind !== 'commit') { return; }
    if (item.classList.contains('disabled')) { return; }
    const action = item.dataset.action;
    if (action === 'exportPatch') {
      vscode.postMessage({ type: 'exportPatch', hashes: [ctxTarget.hash] });
    } else if (action === 'compareWorktree') {
      // Enter working-tree compare mode for this commit: the changed files load
      // in the bottom panel (like a normal selection) and, when clicked, diff
      // against the live working tree instead of the commit's parent.
      compareWorktree = true;
      updateDetailsFromSelection();
    } else {
      vscode.postMessage({
        type: 'commitAction',
        action: action,
        hash: ctxTarget.hash,
        parent: ctxTarget.parent,
        subject: ctxTarget.subject,
      });
    }
    hideCtxMenus();
  });

  multiCtxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item || !ctxTarget || ctxTarget.kind !== 'multi') { return; }
    if (item.dataset.action === 'exportPatch') {
      vscode.postMessage({ type: 'exportPatch', hashes: ctxTarget.hashes });
    } else if (item.dataset.action === 'copyHashes') {
      vscode.postMessage({ type: 'copyHashes', hashes: ctxTarget.hashes });
    }
    hideCtxMenus();
  });

  filesEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.file-row');
    if (!row) { return; }
    e.preventDefault();
    // If right-clicking a file outside the current selection, make it the sole selection.
    if (!row.classList.contains('selected')) {
      clearFileSelection();
      row.classList.add('selected');
    }
    anchorFileRow = row;
    const sel = selectedFileRows();
    const getItem = fileCtxMenu.querySelector('[data-action="getFile"]');
    if (getItem) {
      getItem.classList.toggle('disabled', !currentHash);
      getItem.textContent = sel.length > 1
        ? t('menu.getFiles', sel.length)
        : t('menu.getFileOverwrite');
    }
    const hasCommit = !!currentHash;
    fileCtxMenu.querySelectorAll('[data-action="compareWorktree"], [data-action="openFile"]')
      .forEach(el => el.classList.toggle('disabled', !hasCommit));
    ctxTarget = {
      kind: 'files',
      hash: currentHash || '',
      files: sel.map(r => ({ path: r.dataset.path, oldPath: r.dataset.old || '', status: r.dataset.status || '' })),
    };
    showCtxMenu(fileCtxMenu, e.clientX, e.clientY);
  });

  fileCtxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item || !ctxTarget || ctxTarget.kind !== 'files') { return; }
    if (item.classList.contains('disabled')) { return; }
    const action = item.dataset.action;
    if (action === 'getFile') {
      // GET: restore the LEFT (old) side of each selected file row to the working
      // tree. Applies to every currently-selected file row. parent is the left
      // side in normal mode (commit vs parent); in worktree mode the left side
      // is the commit itself (= hash).
      vscode.postMessage({
        type: 'getFile',
        hash: ctxTarget.hash,
        parent: currentParent || '',
        files: ctxTarget.files,
        compareWorktree: compareWorktree,
      });
    } else if (action === 'openFile') {
      // Open a native diff for each selected file (commit vs parent), like a
      // double-click on a single file row.
      for (const f of ctxTarget.files) {
        vscode.postMessage({
          type: 'openFile',
          hash: ctxTarget.hash,
          parent: currentParent || '',
          path: f.path,
          oldPath: f.oldPath,
          status: f.status,
        });
      }
    } else if (action === 'compareWorktree') {
      // Compare each selected file against the live working-tree file.
      for (const f of ctxTarget.files) {
        vscode.postMessage({
          type: 'compareWorktree',
          hash: ctxTarget.hash,
          path: f.path,
          oldPath: f.oldPath,
          status: f.status,
        });
      }
    }
    hideCtxMenus();
  });

  // Resizable splitter (vertical bar → left/right panes)
  const splitter = document.getElementById('splitter');
  const topEl = document.querySelector('.top');
  const bottomEl = document.querySelector('.bottom');
  let dragging = false;
  splitter.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false; document.body.style.cursor = '';
      // Persist final splitter position
      const flex = bottomEl.style.flexBasis;
      if (flex) { vscode.postMessage({ type: 'saveUiState', patch: { bottomFlex: flex } }); }
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) { return; }
    const total = window.innerWidth;
    const sideW = Math.max(240, Math.min(total - 260, total - e.clientX));
    bottomEl.style.flexBasis = sideW + 'px';
    topEl.style.flexBasis = (total - sideW - 5) + 'px';
    e.preventDefault();
  });

})();
</script>
</body></html>`;
}
