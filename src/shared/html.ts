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
const ICON_TAG = '<svg class="ref-icon" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M1 2.75A1.75 1.75 0 0 1 2.75 1h5.586c.464 0 .909.184 1.237.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.586 5.586a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.75 1.75 0 0 1 1 8.336V2.75zM5 5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>';

/** Render the `%D` decoration string (HEAD/branches/tags/remotes) as styled pills. */
export function renderRefs(refs: string): string {
    if (!refs.trim()) { return ''; }
    return refs.split(',').map(r => r.trim()).filter(Boolean).map(ref => {
        if (ref.startsWith('HEAD ->')) {
            const branch = escapeHtml(ref.slice('HEAD -> '.length));
            return `<span class="ref-pill ref-head">${ICON_BRANCH}<span>${branch}</span></span>`;
        }
        if (ref === 'HEAD') { return `<span class="ref-pill ref-head">${ICON_BRANCH}<span>HEAD</span></span>`; }
        if (ref.startsWith('tag: ')) {
            return `<span class="ref-pill ref-tag">${ICON_TAG}<span>${escapeHtml(ref.slice(5))}</span></span>`;
        }
        if (ref.includes('/')) { return `<span class="ref-pill ref-remote">${ICON_BRANCH}<span>${escapeHtml(ref)}</span></span>`; }
        return `<span class="ref-pill ref-local">${ICON_BRANCH}<span>${escapeHtml(ref)}</span></span>`;
    }).join('');
}
