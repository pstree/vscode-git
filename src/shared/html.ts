// Pure HTML string helpers shared by the (vscode-free) graph/HTML builders.
//
// Keeping these out of `ui.ts` means the lane-graph renderer and the history
// HTML builders never pull the `vscode` module into their dependency graph.

/** Escape a string for safe inclusion in HTML text/attribute values. */
export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Inline SVG icons reused inside the ref pills (currentColor → theme-aware).
const ICON_BRANCH = '<svg class="ref-icon" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.49 2.49 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z"/></svg>';

/** Render only the current-branch part of the `%D` decoration string. */
export function renderRefs(refs: string): string {
    if (!refs) { return ''; }
    const head = refs.split(',')
        .map(r => r.trim()).filter(Boolean)
        .find(r => r.startsWith('HEAD ->'));
    if (!head) { return ''; }
    const branch = escapeHtml(head.slice('HEAD -> '.length));
    return `<span class="ref-pill ref-head">${ICON_BRANCH}<span>${branch}</span></span>`;
}
