// Pure HTML string helpers shared by the (vscode-free) graph/HTML builders.
//
// Keeping these out of `ui.ts` means the lane-graph renderer and the history
// HTML builders never pull the `vscode` module into their dependency graph.

/** Escape a string for safe inclusion in HTML text/attribute values. */
const ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (ch) => ESCAPE_MAP[ch]);
}
