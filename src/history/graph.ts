// SVG lane-graph renderer for the commit history.
//
// Given a topo-ordered list of commits, `computeLayout` assigns each commit to a
// vertical lane (tracking parent/child + merge edges) and `renderRowSvg` /
// `renderCommitRows` turn that layout into the SVG + table rows shown in the
// history webview. Pure: no vscode or git dependency, only `./ui` for HTML helpers.

import { escapeHtml, renderRefs } from '../shared/html';

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

/** Render the full commit list as `<tr>` rows (graph cell + hash/subject/author/date/refs). */
export function renderCommitRows(commits: CommitData[], layouts: RowLayout[], svgWidth: number): string {
    return commits.map((c, i) => {
        const row = layouts[i];
        const parent = c.parents[0] ?? '';
        return `<tr class="commit-row" data-hash="${escapeHtml(c.hash)}" data-parent="${escapeHtml(parent)}" data-display="${escapeHtml(c.display)}" data-subject="${escapeHtml(c.subject)}" data-author="${escapeHtml(c.author)}">
  <td class="col-graph">${renderRowSvg(row, svgWidth)}</td>
  <td class="col-hash">${escapeHtml(c.display)}</td>
  <td class="col-subject" title="${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</td>
  <td class="col-author">${escapeHtml(c.author)}</td>
  <td class="col-date">${escapeHtml(c.date)}</td>
  <td class="col-refs"><div class="refs-inner">${renderRefs(c.refs)}</div></td>
</tr>`;
    }).join('');
}
