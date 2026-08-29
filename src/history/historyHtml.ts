// History webview HTML builders + persisted UI state.
//
// Produces the full HTML document for the bottom-panel history view: the commit
// graph table, file/diff panes, and toolbar. Also persists the small UI state
// (graph position, bottom pane size) per workspace. Depends only on the graph
// renderer and HTML escaping.

import * as vscode from 'vscode';
import { escapeHtml } from '../shared/html';
import { getDict, Lang, makeT, resolveLang } from '../shared/i18n';
import { CommitData, renderCommitRows, RowLayout } from './graph';

// Document scaffolding shared by the three HTML builders below.
const baseCsp = (cspSource: string) => `default-src 'none'; style-src ${cspSource} 'unsafe-inline';`;
const htmlLangOf = (lang: Lang) => (lang === 'zh' ? 'zh-CN' : 'en');

// Shown in the bottom-panel history view before any branch has been selected.
export function placeholderHistoryHtml(cspSource: string, lang: Lang = 'en'): string {
    const t = makeT(lang);
    return `<!DOCTYPE html><html lang="${htmlLangOf(lang)}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${baseCsp(cspSource)}">
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
<body><div>${t('empty.noBranch')}<br>${t('empty.rightClickHint')}</div></body></html>`;
}

// Shown when loading a branch's history fails (mirrors the previous panel.dispose() error path).
export function errorHistoryHtml(cspSource: string, message: string): string {
    return `<!DOCTYPE html><html lang="${htmlLangOf(resolveLang(vscode.env.language))}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${baseCsp(cspSource)}">
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
    allSentinel: string, allowReset: boolean, filePath: string | undefined,
    lang: Lang,
): string {
    const rows = renderCommitRows(commits, layouts, svgWidth);
    const T = makeT(lang);
    const csp = baseCsp(cspSource) + ` script-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:;`;

    // Branch dropdown: the ref the user opened from first (always shown, even if
    // remote), then the remaining local branches, then the "-- ALL --" sentinel.
    const seen = new Set<string>([ref]);
    const options = [`<option value="${escapeHtml(ref)}"${scope === ref ? ' selected' : ''}>${escapeHtml(ref)}</option>`];
    for (const b of branches) {
        if (seen.has(b)) { continue; }
        seen.add(b);
        options.push(`<option value="${escapeHtml(b)}"${scope === b ? ' selected' : ''}>${escapeHtml(b)}</option>`);
    }
    options.push(`<option value="${escapeHtml(allSentinel)}"${scope === allSentinel ? ' selected' : ''}>${T('toolbar.allScope')}</option>`);
    const branchOptions = options.join('\n      ');

    const short = filePath ? (filePath.split('/').pop() || filePath) : '';
    const fileChip = filePath
        ? `<span class="file-chip" title="${T('toolbar.fileChipTitle', escapeHtml(filePath))}"><span class="file-chip-pre">${T('toolbar.pathChip')}</span><span class="file-chip-label">${escapeHtml(short)}</span><button type="button" class="file-chip-clear" id="clear-file" title="${T('toolbar.fileChipClear')}" aria-label="${T('toolbar.fileChipClearAria')}">×</button></span>`
        : '';

    return `<!DOCTYPE html><html lang="${htmlLangOf(lang)}"><head><meta charset="UTF-8">
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
    flex: 0 0 30%; min-width: 100px; max-width: 70%;
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
  .commit-row.filtered-out { display: none; }

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
  /* Shared grid container so the sticky header and every commit row line up on
     the same column tracks. The non-subject columns use auto (content-based)
     sizing, and subject uses minmax(0,1fr) to absorb the remaining width. */
  #history-grid {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto auto;
    align-items: center;
  }
  #commits { display: contents; }
  .history-head, .commit-row {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: subgrid;
    align-items: center;
  }
  .history-head {
    position: sticky; top: 38px; z-index: 9;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .history-head .col {
    padding: 4px 10px;
    text-align: left; font-size: 11px; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.06em; text-transform: uppercase;
    white-space: nowrap;
  }
  .commit-row { cursor: pointer; }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  .commit-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .commit-row .col { min-width: 0; padding: 2px 10px; white-space: nowrap; user-select: none; vertical-align: middle; }
  /* Graph column: cap width so very-wide lane diagrams don't push subject/date off-screen;
     the inner wrapper scrolls horizontally when the SVG exceeds the cap. */
  .col-graph {
    padding-left: 6px; padding-right: 6px;
    max-width: 120px;
    overflow: visible;
  }
  .col-graph .graph-scroll { overflow-x: auto; overflow-y: hidden; }
  .graph-scroll::-webkit-scrollbar { height: 4px; }
  .graph-scroll::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,.3)); }

  .history-head .col-subject, .commit-row .col-subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .col-hash   { color: #e5c07b; font-weight: bold; overflow: hidden; text-overflow: ellipsis; }
  .col-date   { color: var(--vscode-descriptionForeground); text-align: left; padding-right: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .col-author { color: #61afef; overflow: hidden; text-overflow: ellipsis; }

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
  .files-toolbar .commit-info .vs-worktree { color: var(--vscode-charts-blue, #56b6c2); font-weight: 600; }
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
  /* Load-more and export-patch share one secondary-button recipe. */
  .load-more button, .export-patch-btn {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
  }
  .load-more button { padding: 5px 18px; font-size: 12px; }
  .export-patch-btn { padding: 2px 10px; font-size: 11px; line-height: 18px; font-weight: 500; }
  .load-more button:hover:not(:disabled), .export-patch-btn:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  }
  .load-more button:disabled { opacity: 0.5; cursor: default; }
  .export-patch-btn:disabled { opacity: 0.45; cursor: default; }
  .load-more .end-marker {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }

  /* Files-toolbar view toggle (opens the commit diff in a native tab) */
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
</style>
</head>
<body>
<div class="top">
  <div class="toolbar">
    <span class="toolbar-title">${T('toolbar.title')}</span>
    <select class="branch-select" id="branch-select" title="${T('toolbar.branchTitle')}">
      ${branchOptions}
    </select>
    ${fileChip}
    <input type="search" class="history-search" id="history-search" placeholder="${T('toolbar.searchPlaceholder')}" autocomplete="off" spellcheck="false" />
  </div>
  <div id="history-grid">
    <div class="history-head">
      <div class="col col-graph" id="graph-th"></div>
      <div class="col col-hash">${T('table.hash')}</div>
      <div class="col col-subject">${T('table.message')}</div>
      <div class="col col-author">${T('table.author')}</div>
      <div class="col col-date">${T('table.date')}</div>
    </div>
    <div id="commits">${rows}</div>
  </div>
  <div class="load-more" id="load-more">
    ${hasMore
      ? `<button id="load-more-btn">${T('btn.loadMore', commits.length)}</button>`
      : `<span class="end-marker">${T('loadMore.end', commits.length)}</span>`}
  </div>
</div>
<div class="splitter" id="splitter"></div>
<div class="bottom">
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
  // Same {0}/{1} positional interpolation as the host-side t() in shared/i18n.
  function t(key) {
    let s = i18n[key] ?? key;
    for (let i = 1; i < arguments.length; i++) { s = s.split('{' + (i - 1) + '}').join(String(arguments[i])); }
    return s;
  }

  // Mirrors escapeHtml in src/shared/html.ts — kept inline because a webview
  // script cannot import host modules; keep the two in sync.
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Static element refs — all live in the markup above except #clear-file,
  // which renders only when a file scope is active.
  const commitsEl = document.getElementById('commits');
  const filesEl = document.getElementById('files');
  const infoEl = document.getElementById('commit-info');
  const topEl = document.querySelector('.top');
  const bottomEl = document.querySelector('.bottom');
  const topToolbarEl = document.querySelector('.top .toolbar');
  const historyHeadEl = document.querySelector('.history-head');
  const branchSelect = document.getElementById('branch-select');
  const viewToggle = document.getElementById('view-toggle');
  const exportPatchBtn = document.getElementById('export-patch');
  const loadMoreEl = document.getElementById('load-more');
  const searchInput = document.getElementById('history-search');
  const splitter = document.getElementById('splitter');
  const commitCtxMenu = document.getElementById('commit-ctx-menu');
  const multiCtxMenu = document.getElementById('multi-ctx-menu');
  const fileCtxMenu = document.getElementById('file-ctx-menu');

  // Keep the sticky commit-table header flush under the top toolbar.
  // The toolbar height varies (it can wrap), so hard-coding the header's
  // top value left a 1px gap above the header — measure it live instead.
  function syncHeaderTop() {
    historyHeadEl.style.top = (topToolbarEl.offsetHeight) + 'px';
  }
  syncHeaderTop();
  window.addEventListener('resize', syncHeaderTop);

  let currentHash = null;
  let currentParent = null;
  let compareWorktree = false; // when true, file clicks diff the commit against the live working tree

  // File-scoped history: when the user switches the branch dropdown away from
  // the original branch, commit clicks show the diff between the working-tree
  // file and that commit's (selected branch's) version — instead of the usual
  // commit-vs-parent diff — so the right side reflects "working file vs other
  // branch". initialRef is the branch the view was opened with; currentScope
  // tracks the dropdown selection (updated when the host confirms a scope change).
  const fileScoped = ${!!filePath};
  const initialRef = ${JSON.stringify(ref)};
  let currentScope = ${JSON.stringify(scope)};
  function shouldWorktreeCompare() {
    return fileScoped && currentScope !== initialRef;
  }

  function splitPath(p) {
    const i = p.lastIndexOf('/');
    if (i === -1) { return { dir: '', name: p }; }
    return { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
  }

  function showFilesEmpty(html) {
    filesEl.innerHTML = '<div class="files-empty">' + html + '</div>';
  }

  function renderFiles(files) {
    if (!files.length) {
      showFilesEmpty(t('empty.noFiles'));
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

  // Selection state — multi-select: plain click = single, ctrl/cmd+click = toggle, shift+click = contiguous range.
  let anchorRow = null; // last explicitly-clicked row, used as shift-range anchor

  function allRows() {
    return Array.from(commitsEl.querySelectorAll('.commit-row'));
  }
  function visibleRows() {
    return allRows().filter(r => !r.classList.contains('filtered-out'));
  }
  function selectedRows() {
    // DOM order: index 0 = newest (topo-order).
    return Array.from(commitsEl.querySelectorAll('.commit-row.selected'));
  }
  // The multi-selection diff range (oldest → newest selected commit), or null
  // when fewer than two rows are selected. Derived from the DOM so there is no
  // duplicate selection state to reset.
  function currentRange() {
    const sel = selectedRows();
    return sel.length > 1 ? { from: sel[sel.length - 1].dataset.hash, to: sel[0].dataset.hash } : null;
  }
  function clearSelection() {
    selectedRows().forEach(r => r.classList.remove('selected'));
  }

  function refreshExportButton() {
    exportPatchBtn.disabled = !(currentHash || currentRange());
  }

  function updateDetailsFromSelection() {
    const sel = selectedRows();
    if (sel.length === 0) {
      currentHash = null;
      currentParent = null;
      infoEl.textContent = '';
      showFilesEmpty(t('empty.selectCommit'));
      refreshExportButton();
      return;
    }
    if (sel.length === 1) {
      const row = sel[0];
      currentHash = row.dataset.hash;
      currentParent = row.dataset.parent || '';
      let info = '<span class="hash">' + escapeHtml(row.dataset.display) + '</span>';
      if (compareWorktree) {
        info += ' <span class="vs-worktree">' + t('info.vsWorktree') + '</span>';
      }
      infoEl.innerHTML = info;
      showFilesEmpty(t('state.loading'));
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
    const range = currentRange();
    currentHash = null;
    currentParent = null;
    const shortFrom = (sel[sel.length - 1].dataset.display || range.from.slice(0, 8));
    const shortTo   = (sel[0].dataset.display || range.to.slice(0, 8));
    infoEl.innerHTML =
      '<span class="hash">' + escapeHtml(shortFrom) + '..' + escapeHtml(shortTo) + '</span>' +
      sel.length + t('info.rangeDiff');
    showFilesEmpty(t('state.loading'));
    vscode.postMessage({ type: 'selectRange', fromHash: range.from, toHash: range.to });
    refreshExportButton();
  }

  commitsEl.addEventListener('click', (e) => {
    const row = e.target.closest('.commit-row');
    if (!row) { return; }
    // File-scoped history with a non-original branch selected → compare the
    // selected commit against the live working tree (file vs other branch).
    compareWorktree = shouldWorktreeCompare();
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

  // Files-toolbar toggle: open the selected commit's diff in its own tab.
  viewToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view="diff"]');
    if (!btn || !currentHash || currentRange()) { return; }
    // When in worktree-compare mode, carry that flag through so the new tab
    // diffs the commit against the live working tree (not its parent).
    vscode.postMessage({ type: 'openCommitDiffTab', hash: currentHash, parent: currentParent, compareWorktree: compareWorktree });
  });

  // Export Patch button on the Files Changed title bar.
  exportPatchBtn.addEventListener('click', () => {
    const range = currentRange();
    if (range) {
      vscode.postMessage({ type: 'exportPatch', hashes: [range.from, range.to] });
    } else if (currentHash) {
      if (compareWorktree) {
        // Working-tree comparison: export the diff between the commit and the live working tree.
        vscode.postMessage({ type: 'exportWorktreePatch', hash: currentHash });
      } else {
        vscode.postMessage({ type: 'exportPatch', hashes: [currentHash] });
      }
    }
  });

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
    const range = currentRange();
    if (range) {
      vscode.postMessage({
        type: 'openFile',
        fromHash: range.from,
        toHash: range.to,
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

  function attachLoadMoreHandler() {
    const btn = document.getElementById('load-more-btn');
    if (!btn) { return; }
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = t('state.loading');
      vscode.postMessage({ type: 'loadMore' });
    });
  }
  attachLoadMoreHandler();

  // Rebuild the load-more area; the loaded count is read back from the table.
  function renderLoadMore(hasMore) {
    const loaded = commitsEl.querySelectorAll('.commit-row').length;
    loadMoreEl.innerHTML = hasMore
      ? '<button id="load-more-btn">' + t('btn.loadMore', loaded) + '</button>'
      : '<span class="end-marker">' + t('loadMore.end', loaded) + '</span>';
    if (hasMore) { attachLoadMoreHandler(); }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type === 'i18n') {
      i18n = m.dict || {};
      return;
    }
    // Commit files and range files render identically — only the guard differs.
    const range = currentRange();
    const commitFiles = m?.type === 'files' && m.hash === currentHash && !range;
    const rangeFiles = m?.type === 'rangeFiles' && range && m.fromHash === range.from && m.toHash === range.to;
    if (commitFiles || rangeFiles) {
      if (m.error) {
        showFilesEmpty(escapeHtml(m.error));
      } else {
        renderFiles(m.files);
      }
    } else if (m?.type === 'moreCommits') {
      commitsEl.insertAdjacentHTML('beforeend', m.rowsHtml);
      applySearchFilter();
      renderLoadMore(m.hasMore);
    } else if (m?.type === 'loadMoreError') {
      const btn = document.getElementById('load-more-btn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = t('btn.loadMoreRetry', m.error || 'unknown');
      }
      branchSelect.disabled = false;
    } else if (m?.type === 'resetCommits') {
      // Scope changed — replace all rows, reset selection & file panel
      commitsEl.innerHTML = m.rowsHtml;
      anchorRow = null;
      currentHash = null;
      currentParent = null;
      currentScope = m.scope;
      // File-scoped history: after switching away from the original branch,
      // commits compare against the working tree (file vs other branch).
      compareWorktree = shouldWorktreeCompare();
      clearSelection();
      refreshExportButton();
      infoEl.textContent = '';
      showFilesEmpty(t('empty.selectCommit'));
      // Sync dropdown to confirmed scope, re-enable it
      if (branchSelect.value !== m.scope) { branchSelect.value = m.scope; }
      branchSelect.disabled = false;
      renderLoadMore(m.hasMore);
      applySearchFilter();
      syncHeaderTop();
      // Scroll to top of the table for the new scope
      topEl.scrollTop = 0;
    }
  });

  // Branch dropdown — picks a local branch ref or the "-- ALL --" sentinel.
  branchSelect.addEventListener('change', () => {
    branchSelect.disabled = true;
    vscode.postMessage({ type: 'setScope', scope: branchSelect.value });
  });

  // File-scope chip — clear the file filter and return to full branch history.
  const clearFileBtn = document.getElementById('clear-file');
  if (clearFileBtn) {
    clearFileBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearFileScope' });
    });
  }

  // Search box — client-side filter over already-loaded commits.
  let searchQuery = '';
  function applySearchFilter() {
    const q = searchQuery.trim().toLowerCase();
    const targets = commitsEl.querySelectorAll('.commit-row');
    if (!q) {
      targets.forEach(tr => tr.classList.remove('filtered-out'));
      return;
    }
    // data-search is a pre-lowercased hash/display/subject/author haystack
    // emitted by the host (graph.ts) — one attribute read per row.
    targets.forEach(tr => tr.classList.toggle('filtered-out', !(tr.dataset.search || '').includes(q)));
  }
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    applySearchFilter();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchInput.value = ''; searchQuery = ''; applySearchFilter(); }
  });

  // Right-click context menus (commit rows + file rows)
  let ctxTarget = null; // { kind: 'commit'|'multi'|'files', ... }

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
    const row = e.target.closest('.commit-row');
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
    const getFileItem = fileCtxMenu.querySelector('[data-action="getFile"]');
    getFileItem.classList.toggle('disabled', !currentHash);
    getFileItem.textContent = sel.length > 1
      ? t('menu.getFiles', sel.length)
      : t('menu.getFileOverwrite');
    fileCtxMenu.querySelector('[data-action="compareWorktree"]').classList.toggle('disabled', !currentHash);
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
  let dragging = false;
  splitter.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false; document.body.style.cursor = '';
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
