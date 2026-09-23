// SVG lane-graph renderer for the commit history.
//
// Given a topo-ordered list of commits, `computeLayout` assigns each commit to a
// vertical lane (tracking parent/child + merge edges) and `renderRowSvg` /
// `renderCommitRows` turn that layout into the SVG + table rows shown in the
// history webview. Pure: no vscode or git dependency, only `./ui` for HTML helpers.

import { escapeHtml } from '../shared/html';

const GRAPH_COLORS = ['#61afef', '#98c379', '#e5c07b', '#e06c75', '#c678dd', '#56b6c2', '#d19a66'];
export const LANE_W = 14;
const ROW_H = 22;
const DOT_R = 3.5;

export interface CommitData {
    hash: string;
    display: string;
    parents: string[];
    refs: string;
    subject: string;
    date: string;
    author: string;
    // Committer timestamp (seconds) — used to merge-sort commits across
    // repositories in "all projects" mode (topo-order only works per repo).
    ts?: number;
    // Owning repository's root path — set only in "all projects" mode so each
    // row can carry `data-repo` back to the host and show a project badge.
    repoPath?: string;
}

export interface RowLayout {
    col: number;
    color: string;
    colColors: string[];
    topLanes: (string | null)[];
    botLanes: (string | null)[];
    firstParentConvergesTo: number | null;
    mergeParents: { targetCol: number; color: string }[];
}

export interface LayoutState {
    lanes: (string | null)[];
    laneColors: string[];
    nextColor: number;
}

export function createLayoutState(): LayoutState {
    return { lanes: [], laneColors: [], nextColor: 0 };
}

/**
 * Assign each commit a lane, producing per-row layout used by the renderer.
 *
 * `state` carries lane allocation across pages (load-more) so edges stay
 * continuous. `flat` mode (used for file-scoped history, where the commit set is
 * sparse) renders each commit as a lone dot instead of reserving lanes for
 * parents that aren't in the set — which would otherwise draw dangling verticals.
 */
export function computeLayout(commits: CommitData[], state: LayoutState = createLayoutState(), flat = false): RowLayout[] {
    const lanes = state.lanes;
    const laneColors = state.laneColors;

    return commits.map(commit => {
        // File-scoped history is a sparse commit set: a commit's parent is usually
        // not among the listed commits, so the lane algorithm would reserve a lane
        // for that missing parent and draw a vertical line that never converges.
        // In flat mode we render each commit as a lone dot — no dangling edges.
        if (flat) {
            const color = laneColors[0] ?? GRAPH_COLORS[0];
            if (!laneColors[0]) { laneColors[0] = color; }
            return { col: 0, color, colColors: [color], topLanes: [null], botLanes: [null], firstParentConvergesTo: null, mergeParents: [] };
        }

        // Find or allocate a lane for this commit
        let col = lanes.indexOf(commit.hash);
        if (col === -1) {
            const free = lanes.indexOf(null);
            if (free !== -1) {
                col = free;
                laneColors[col] = GRAPH_COLORS[state.nextColor++ % GRAPH_COLORS.length];
            } else {
                col = lanes.length;
                lanes.push(null);
                laneColors.push(GRAPH_COLORS[state.nextColor++ % GRAPH_COLORS.length]);
            }
        }
        const color = laneColors[col];

        const topLanes: (string | null)[] = lanes.slice();
        while (topLanes.length <= col) { topLanes.push(null); }

        let firstParentConvergesTo: number | null = null;
        const mergeParents: { targetCol: number; color: string }[] = [];

        if (commit.parents.length === 0) {
            lanes[col] = null;
        } else {
            const p0Lane = lanes.indexOf(commit.parents[0]);
            if (p0Lane === -1 || p0Lane === col) {
                lanes[col] = commit.parents[0];
            } else {
                // First parent already tracked by another lane — converge
                lanes[col] = null;
                firstParentConvergesTo = p0Lane;
            }
            for (const p of commit.parents.slice(1)) {
                const pLane = lanes.indexOf(p);
                if (pLane !== -1) {
                    mergeParents.push({ targetCol: pLane, color: laneColors[pLane] ?? color });
                } else {
                    let newCol = lanes.indexOf(null);
                    if (newCol === -1) { newCol = lanes.length; lanes.push(null); }
                    if (!laneColors[newCol]) { laneColors[newCol] = GRAPH_COLORS[state.nextColor++ % GRAPH_COLORS.length]; }
                    lanes[newCol] = p;
                    mergeParents.push({ targetCol: newCol, color: laneColors[newCol] });
                }
            }
        }

        const botLanes: (string | null)[] = lanes.slice();
        while (botLanes.length <= col) { botLanes.push(null); }

        return { col, color, colColors: laneColors.slice(), topLanes, botLanes, firstParentConvergesTo, mergeParents };
    });
}

/** Render one row's lane SVG (pass-through verticals, parent/merge curves, dot). */
function renderRowSvg(row: RowLayout, svgWidth: number): string {
    const cx = row.col * LANE_W + LANE_W / 2;
    const cy = ROW_H / 2;
    const els: string[] = [];
    const maxJ = Math.max(row.topLanes.length, row.botLanes.length);

    // Pass-through verticals for other lanes
    for (let j = 0; j < maxJ; j++) {
        if (j === row.col) { continue; }
        const x = j * LANE_W + LANE_W / 2;
        const top = j < row.topLanes.length ? row.topLanes[j] : null;
        const bot = j < row.botLanes.length ? row.botLanes[j] : null;
        const c = (j < row.colColors.length ? row.colColors[j] : null) ?? GRAPH_COLORS[j % GRAPH_COLORS.length];
        if (top !== null && bot !== null) {
            els.push(`<line x1="${x}" y1="0" x2="${x}" y2="${ROW_H}" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/>`);
        }
    }

    // Incoming line from above (to commit dot)
    if (row.topLanes[row.col] !== null) {
        els.push(`<line x1="${cx}" y1="0" x2="${cx}" y2="${cy}" stroke="${row.color}" stroke-width="1.5" stroke-linecap="round"/>`);
    }
    // Outgoing line below (first parent, same lane)
    if (row.botLanes[row.col] !== null) {
        els.push(`<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${ROW_H}" stroke="${row.color}" stroke-width="1.5" stroke-linecap="round"/>`);
    }
    // First parent converges to another lane
    if (row.firstParentConvergesTo !== null) {
        const tx = row.firstParentConvergesTo * LANE_W + LANE_W / 2;
        els.push(`<path d="M ${cx},${cy} C ${cx},${ROW_H} ${tx},${cy} ${tx},${ROW_H}" fill="none" stroke="${row.color}" stroke-width="1.5" stroke-linecap="round"/>`);
    }
    // Merge parents — bezier curves from dot to each parent lane bottom
    for (const mp of row.mergeParents) {
        const tx = mp.targetCol * LANE_W + LANE_W / 2;
        els.push(`<path d="M ${cx},${cy} C ${cx},${ROW_H} ${tx},${cy} ${tx},${ROW_H}" fill="none" stroke="${mp.color}" stroke-width="1.5" stroke-linecap="round"/>`);
    }
    // Commit dot (drawn last, appears on top)
    els.push(`<circle cx="${cx}" cy="${cy}" r="${DOT_R}" fill="${row.color}" stroke="var(--vscode-editor-background,#1e1e1e)" stroke-width="1.5"/>`);

    return `<svg width="${svgWidth}" height="${ROW_H}" style="display:block;overflow:visible" xmlns="http://www.w3.org/2000/svg">${els.join('')}</svg>`;
}

// How many branch chips the (width-capped) Branch column renders before the rest
// collapse into a "+N" summary. Two fits the common `main` + `origin/main` pair
// while leaving the remaining refs readable through the cell's tooltip.
const MAX_BRANCH_CHIPS = 2;

/**
 * Turn a commit's `%D` decoration string into the Branch column's content:
 * one chip per branch pointing at the commit, with the checked-out branch
 * (`HEAD -> x`) highlighted. Tags and symbolic `HEAD` / `<remote>/HEAD` refs
 * are dropped — the column is about branches. At most MAX_BRANCH_CHIPS chips are
 * rendered (then "+N") because the column is width-capped: rendering every ref
 * would divide that cap into unreadable slivers. `text` always lists them all
 * and becomes the cell's tooltip.
 */
function renderRefChips(refs: string): { html: string; text: string } {
    if (!refs) { return { html: '', text: '' }; }
    const names: string[] = [];
    let current = '';
    for (const raw of refs.split(',')) {
        const item = raw.trim();
        if (!item || item.startsWith('tag: ')) { continue; }
        const arrow = item.indexOf(' -> ');
        if (arrow !== -1) {
            // `HEAD -> main` is the checked-out branch; `origin/HEAD -> …` is a
            // symbolic remote HEAD and not a branch of its own.
            if (!item.startsWith('HEAD -> ')) { continue; }
            const name = item.slice(arrow + 4).trim();
            if (!name) { continue; }
            if (!names.includes(name)) { names.push(name); }
            current = name;
            continue;
        }
        // Plain `HEAD` / `origin/HEAD`-style symbolic refs aren't branches.
        if (item === 'HEAD' || item.endsWith('/HEAD')) { continue; }
        if (!names.includes(item)) { names.push(item); }
    }
    const shown = names.slice(0, MAX_BRANCH_CHIPS);
    const hidden = names.length - shown.length;
    const html = shown
        .map(n => `<span class="ref-chip${n === current ? ' ref-head' : ''}">${escapeHtml(n)}</span>`)
        .join('') + (hidden > 0 ? `<span class="ref-chip ref-chip-more">+${hidden}</span>` : '');
    return { html, text: names.join('  ') };
}

/**
 * Render the full commit list as `<div class="commit-row">` rows (graph cell +
 * hash / project / subject / author / date / branch). `showProject` adds the
 * leading Project column used in "all projects" mode; it MUST match the header
 * (a row cell without a matching header cell would shift the subject column).
 */
export function renderCommitRows(commits: CommitData[], layouts: RowLayout[], svgWidth: number, showProject = false): string {
    return commits.map((c, i) => {
        const row = layouts[i];
        const parent = c.parents[0] ?? '';
        // All-projects mode: rows carry their owning repo (so host-side actions
        // route to the right repository) and get a Project cell of their own —
        // keeping the repo out of the subject cell so the message lines up with
        // its column header.
        const repoName = c.repoPath ? (c.repoPath.split(/[\\/]/).pop() || c.repoPath) : '';
        const repoAttr = c.repoPath ? ` data-repo="${escapeHtml(c.repoPath)}"` : '';
        const projectCell = showProject
            ? `\n  <div class="col col-project" title="${escapeHtml(c.repoPath ?? '')}"><span class="repo-badge">${escapeHtml(repoName)}</span></div>`
            : '';
        // Pre-lowercased haystack for the client-side search filter (one read
        // per row instead of several dataset reads + toLowerCase calls). The
        // author is deliberately excluded — it has its own dedicated filter box
        // (which matches `data-author`).
        const search = (c.hash + '\n' + c.display + '\n' + c.subject + (repoName ? '\n' + repoName : '')).toLowerCase();
        const branches = renderRefChips(c.refs);
        return `<div class="commit-row" data-hash="${escapeHtml(c.hash)}" data-parent="${escapeHtml(parent)}" data-display="${escapeHtml(c.display)}" data-subject="${escapeHtml(c.subject)}" data-author="${escapeHtml(c.author)}" data-search="${escapeHtml(search)}"${repoAttr}>
  <div class="col col-graph"><div class="graph-scroll">${renderRowSvg(row, svgWidth)}</div></div>
  <div class="col col-hash">${escapeHtml(c.display)}</div>${projectCell}
  <div class="col col-subject" title="${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</div>
  <div class="col col-author">${escapeHtml(c.author)}</div>
  <div class="col col-date">${escapeHtml(c.date)}</div>
  <div class="col col-branch" title="${escapeHtml(branches.text)}">${branches.html}</div>
</div>`;
    }).join('');
}
