// The bottom-panel "Git History" webview view.
//
// Hosts the branch-history commit graph as a docked WebviewView (alongside
// Terminal / Output / Problems). The view is reused across invocations: each
// "View History" call re-scopes the same view instead of opening a new tab.
// `context`/`gitApi` are injected via the constructor; everything else comes
// from the sibling modules.

import * as path from 'path';
import * as vscode from 'vscode';
import { getDict, resolveLang, t } from '../shared/i18n';
import { GitApi, Repository } from '../gitApi';
import type { BranchItem } from '../branchTreeProvider';
import { errText, findRepoForFile } from '../shared/ui';

import { execFileAsync, getChangedFiles, getChangedFilesBetween, getChangedFilesVsWorktree, getCommitDiff, getFileFromCommit, getGitPath, SHOW_MAX_BUFFER } from '../git/gitClient';
import { CommitData, LANE_W, RowLayout, computeLayout, createLayoutState, renderCommitRows } from './graph';
import { buildHistoryHtml, errorHistoryHtml, placeholderHistoryHtml } from './historyHtml';
import { openCommitFileDiff, openRangeFileDiff, openCompareWithWorktree } from './commitFileProvider';
import { exportPatches, exportWorktreePatch, handleCommitAction } from './commitActions';

export const HISTORY_VIEW_TYPE = 'gitBranches.historyView';

export class HistoryViewProvider implements vscode.WebviewViewProvider {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly gitApi: GitApi,
    ) {
        // Reload the Git History view whenever the checked-out branch changes
        // (e.g. after a Checkout) so `isCurrentBranch` — and thus the Reset
        // availability — is recomputed instead of staying stale.
        for (const repo of gitApi.repositories) { this.watchRepoHead(repo); }
        this.context.subscriptions.push(
            gitApi.onDidOpenRepository(repo => this.watchRepoHead(repo)),
        );

        // Re-render (and re-push the i18n dictionary) when VS Code's display
        // language changes, so the view follows the user's language switch
        // without requiring a reload. `onDidChangeLanguage` only exists on
        // VS Code 1.86+, so access it defensively (the engine floor is 1.85).
        const env = vscode.env as unknown as {
            onDidChangeLanguage?: (cb: () => void) => vscode.Disposable;
        };
        if (env.onDidChangeLanguage) {
            this.context.subscriptions.push(env.onDidChangeLanguage(() => void this.reloadForLanguage()));
        }
    }

    // Re-apply the current language after a `vscode.env.language` change.
    private async reloadForLanguage(): Promise<void> {
        const view = this.view;
        if (!view) { return; }
        const lang = resolveLang(vscode.env.language);
        view.webview.postMessage({ type: 'i18n', dict: getDict(lang) });
        if (this.repo && this.fullRef) {
            await this.loadSession(this.repo, this.fullRef, this.filePath);
        } else {
            view.webview.html = placeholderHistoryHtml(view.webview.cspSource, lang);
        }
    }

    // Per-repo HEAD-change listeners, keyed by repo path. A re-opened repo with
    // the same path replaces (disposes) the old listener instead of stacking a
    // stale one that still points at the previously closed repository.
    private repoWatch = new Map<string, vscode.Disposable>();
    // Last known checked-out branch name for the repo currently shown.
    private lastHeadName: string | undefined;

    private watchRepoHead(repo: Repository): void {
        const key = repo.rootUri.fsPath;
        this.repoWatch.get(key)?.dispose();
        const sub = repo.state.onDidChange(() => {
            if (!this.view || !this.repo) { return; }
            if (this.repo.rootUri.fsPath !== repo.rootUri.fsPath) { return; }
            const headName = repo.state.HEAD?.name;
            if (headName === this.lastHeadName) { return; } // only react to HEAD changes
            this.lastHeadName = headName;
            void this.loadSession(this.repo, this.fullRef, this.filePath);
        });
        this.repoWatch.set(key, sub);
        this.context.subscriptions.push(sub);
    }

    private static readonly PAGE_SIZE = 200;
    private static readonly SEP = '\x01';
    private static readonly ALL_SENTINEL = '__ALL__';
    // Commit actions that mutate history and therefore require a list reload.
    private static readonly RELOAD_ACTIONS = new Set(['resetSoft', 'resetHard', 'revert', 'cherryPick', 'createBranch', 'checkout']);

    private view?: vscode.WebviewView;
    private pending?: { repo: Repository; fullRef: string; filePath?: string };

    // Active session state (reset whenever loadSession() targets a new scope).
    private repo?: Repository;
    private fullRef = '';
    private filePath: string | undefined;
    private scope = '';
    private layoutState = createLayoutState();
    private loadedCount = 0;
    private currentSvgWidth = LANE_W;
    // Bumped whenever loadSession()/setScope() starts a new scope. In-flight
    // async loads capture the generation before awaiting and abandon their
    // result if it changed, so a late response can't corrupt the new scope.
    private sessionGen = 0;

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.onDidReceiveMessage(
            (msg) => { void this.handleMessage(msg); },
            undefined,
            this.context.subscriptions,
        );
        webviewView.onDidDispose(() => { this.view = undefined; }, undefined, this.context.subscriptions);

        // Push the active language dictionary to the webview so its runtime
        // (dynamically generated) fragments can localize via a local t().
        const lang = resolveLang(vscode.env.language);
        webviewView.webview.postMessage({ type: 'i18n', dict: getDict(lang) });

        if (this.pending) {
            const p = this.pending;
            this.pending = undefined;
            void this.loadSession(p.repo, p.fullRef, p.filePath);
        } else {
            webviewView.webview.html = placeholderHistoryHtml(webviewView.webview.cspSource, lang);
        }
    }

    // Called by the "View History" command. Reveals the docked view and
    // (re)scopes it to the requested branch / file.
    async show(repo: Repository, fullRef: string, filePath?: string): Promise<void> {
        if (this.view) {
            this.view.show(true);
            await this.loadSession(repo, fullRef, filePath);
            return;
        }
        // Not yet rendered: stash the request, then reveal the view. VS Code
        // then fires resolveWebviewView(), which consumes the stashed request.
        this.pending = { repo, fullRef, filePath };
        try {
            await vscode.commands.executeCommand(`${HISTORY_VIEW_TYPE}.focus`);
        } catch {
            await vscode.commands.executeCommand('workbench.view.extension.gitBranches-history');
        }
    }

    private async listLocalBranches(): Promise<string[]> {
        if (!this.repo) { return []; }
        try {
            const branches = await this.repo.getBranches({ remote: false });
            return branches.map(b => b.name).filter((n): n is string => !!n).sort();
        } catch {
            return [];
        }
    }

    private async fetchCommits(scope: string, skip: number, count: number): Promise<CommitData[]> {
        if (!this.repo) { return []; }
        const SEP = HistoryViewProvider.SEP;
        const ALL_SENTINEL = HistoryViewProvider.ALL_SENTINEL;
        const args = [
            'log', '--topo-order',
            `--skip=${skip}`,
            `--max-count=${count}`,
            `--date=format-local:%Y-%m-%d %H:%M`,
            `--pretty=format:%H${SEP}%h${SEP}%P${SEP}%D${SEP}%s${SEP}%ad${SEP}%an`,
        ];
        if (scope === ALL_SENTINEL) {
            args.push('--all');
        } else {
            args.push(scope);
        }
        if (this.filePath) { args.push('--', this.filePath); }
        const { stdout } = await execFileAsync(getGitPath(), args, { cwd: this.repo.rootUri.fsPath, maxBuffer: SHOW_MAX_BUFFER });
        return stdout.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split(SEP);
            return {
                hash:    parts[0] ?? '',
                display: parts[1] ?? '',
                parents: (parts[2] ?? '').trim().split(/\s+/).filter(Boolean),
                refs:    parts[3] ?? '',
                subject: parts[4] ?? '',
                date:    parts[5] ?? '',
                author:  parts[6] ?? '',
            };
        });
    }

    private bumpSvgWidth(layouts: RowLayout[]): void {
        const cols = Math.max(1, ...layouts.map(r => Math.max(r.topLanes.length, r.botLanes.length)));
        this.currentSvgWidth = Math.max(this.currentSvgWidth, cols * LANE_W);
    }

    // (Re)load the view with the history of `fullRef` (optionally a single file).
    private async loadSession(repo: Repository, fullRef: string, filePath?: string): Promise<void> {
        this.repo = repo;
        this.fullRef = fullRef;
        this.filePath = filePath;
        this.lastHeadName = repo.state.HEAD?.name;
        this.scope = fullRef;
        this.layoutState = createLayoutState();
        this.currentSvgWidth = LANE_W;
        this.loadedCount = 0;
        const gen = ++this.sessionGen;

        const view = this.view;
        if (!view) { return; }
        try {
            const [first, branches] = await Promise.all([
                this.fetchCommits(this.scope, 0, HistoryViewProvider.PAGE_SIZE),
                this.listLocalBranches(),
            ]);
            if (gen !== this.sessionGen) { return; }
            const firstLayouts = computeLayout(first, this.layoutState, !!this.filePath);
            this.bumpSvgWidth(firstLayouts);
            this.loadedCount = first.length;
            const hasMore = first.length === HistoryViewProvider.PAGE_SIZE;

            const head = repo.state.HEAD;
            const isCurrentBranch = head?.name === this.fullRef;
            // `git reset <hash>` operates on the checked-out branch regardless of
            // whether it has an upstream, so reset is allowed for the current
            // branch even without one (no upstream ≠ no reset).
            const allowReset = isCurrentBranch;
            view.webview.html = buildHistoryHtml(
                first, firstLayouts, this.fullRef, view.webview.cspSource,
                this.currentSvgWidth, hasMore, this.scope, branches,
                HistoryViewProvider.ALL_SENTINEL, allowReset, this.filePath,
                resolveLang(vscode.env.language),
            );
        } catch (e: any) {
            view.webview.html = errorHistoryHtml(view.webview.cspSource, errText(e));
        }
    }

    /**
     * Re-load the currently-shown history session if it belongs to the same
     * repository and branch. Invoked after a branch pull completes so the Git
     * History list reflects the newly pulled commits.
     */
    async refreshIfMatches(repo: Repository, refName: string): Promise<void> {
        if (!this.view || !this.repo) { return; }
        if (this.repo.rootUri.fsPath !== repo.rootUri.fsPath) { return; }
        if (this.fullRef !== refName) { return; }
        await this.loadSession(this.repo, this.fullRef, this.filePath);
    }

    private async handleMessage(msg: any): Promise<void> {
        const view = this.view;
        const repo = this.repo;
        if (!view || !repo) { return; }

        // Thin dispatch: each message type maps to one small handler below, so no
        // single method grows into a long if/else chain.
        switch (msg?.type) {
            case 'selectCommit': return this.postChangedFiles(view, { type: 'files', hash: msg.hash }, () =>
                getChangedFiles(repo, msg.hash, msg.parent, this.filePath));
            case 'selectCommitWorktree': return this.postChangedFiles(view, { type: 'files', hash: msg.hash }, () =>
                getChangedFilesVsWorktree(repo, msg.hash, this.filePath));
            case 'selectCommitDiff': return this.postChangedFiles(view, { type: 'commitDiff', hash: msg.hash }, () =>
                getCommitDiff(repo, msg.hash, msg.parent, this.filePath));
            case 'selectRange': return this.postChangedFiles(view,
                { type: 'rangeFiles', fromHash: msg.fromHash, toHash: msg.toHash }, () =>
                    getChangedFilesBetween(repo, msg.fromHash, msg.toHash, this.filePath));
            case 'openCommitDiffTab': return this.openCommitDiffTab(msg, repo);
            case 'openFile': return this.openFile(msg, repo);
            case 'compareWorktree': return this.compareFileWorktree(msg, repo);
            case 'loadMore': return this.loadMore(view);
            case 'setScope': return this.setScope(msg, view);
            case 'openFileHistory': return this.openFileHistory(msg, repo);
            case 'clearFileScope': return this.show(repo, this.fullRef, undefined);
            case 'commitAction': return this.commitAction(msg, repo);
            case 'exportPatch': return this.exportPatch(msg, repo);
            case 'exportWorktreePatch': return this.exportWorktreePatch(msg, repo);
            case 'getFile': return this.getFile(msg, repo, view);
            case 'copyHashes': return this.copyHashes(msg);
            default: return; // unknown type — ignore
        }
    }

    // Fetch a changed-file list and post it to the webview; on error post an empty
    // list carrying the message. Shared by the four select* handlers.
    private async postChangedFiles(
        view: vscode.WebviewView,
        payload: Record<string, unknown>,
        fetch: () => Promise<Array<{ status: string; path: string; oldPath?: string }>>,
    ): Promise<void> {
        try {
            const files = await fetch();
            view.webview.postMessage({ ...payload, files });
        } catch (e: any) {
            view.webview.postMessage({ ...payload, files: [], error: errText(e) });
        }
    }

    // Open each changed file as a NATIVE VS Code compare editor (vscode.diff) so
    // the built-in compareEditor.nextChange/previousChange shortcuts (e.g. F7 /
    // Shift+F7) can jump between diff hunks. A webview diff can't receive those
    // keybindings. In file-scoped history only the tracked file opens.
    private async openCommitDiffTab(msg: any, repo: Repository): Promise<void> {
        try {
            const worktree = !!msg.compareWorktree;
            const files = worktree
                ? await getChangedFilesVsWorktree(repo, msg.hash, this.filePath)
                : await getChangedFiles(repo, msg.hash, msg.parent, this.filePath);
            if (files.length === 0) {
                vscode.window.showInformationMessage(
                    worktree ? 'No file changes vs working tree.' : 'No file changes in this commit.');
                return;
            }
            for (const f of files) {
                if (worktree) {
                    // Compare the commit's version (left, read-only) against the live
                    // working-tree file (right) — matching the bottom panel's list.
                    await openCompareWithWorktree(repo, msg.hash, f.status, f.path, f.oldPath);
                } else {
                    await openCommitFileDiff(this.gitApi, repo, msg.hash, msg.parent, f.status, f.path, f.oldPath);
                }
            }
        } catch (e: any) {
            vscode.window.showErrorMessage('Failed to open commit diff: ' + errText(e));
        }
    }

    private async openFile(msg: any, repo: Repository): Promise<void> {
        if (msg.fromHash && msg.toHash) {
            await openRangeFileDiff(repo, msg.fromHash, msg.toHash, msg.status, msg.path, msg.oldPath);
        } else if (msg.compareWorktree) {
            // Compare the selected commit's version (left, read-only) against the live
            // editable working file (right) so changes can be applied via << / >>.
            await openCompareWithWorktree(repo, msg.hash, msg.status, msg.path, msg.oldPath);
        } else {
            await openCommitFileDiff(this.gitApi, repo, msg.hash, msg.parent, msg.status, msg.path, msg.oldPath);
        }
    }

    // "Compare with working tree" from a FILE row's right-click menu: diff a single
    // file's committed version (read-only left) against the live editable working
    // file (right). path/oldPath/status come straight from the row.
    private async compareFileWorktree(msg: any, repo: Repository): Promise<void> {
        try {
            await openCompareWithWorktree(repo, msg.hash, msg.status, msg.path, msg.oldPath);
        } catch (e: any) {
            vscode.window.showErrorMessage(t('diff.compareWorktreeFailed', errText(e)));
        }
    }

    private async loadMore(view: vscode.WebviewView): Promise<void> {
        try {
            const gen = this.sessionGen;
            const next = await this.fetchCommits(this.scope, this.loadedCount, HistoryViewProvider.PAGE_SIZE);
            if (gen !== this.sessionGen) { return; }
            const nextLayouts = computeLayout(next, this.layoutState, !!this.filePath);
            this.bumpSvgWidth(nextLayouts);
            this.loadedCount += next.length;
            view.webview.postMessage({
                type: 'moreCommits',
                rowsHtml: renderCommitRows(next, nextLayouts, this.currentSvgWidth),
                svgWidth: this.currentSvgWidth,
                added: next.length,
                hasMore: next.length === HistoryViewProvider.PAGE_SIZE,
            });
        } catch (e: any) {
            view.webview.postMessage({ type: 'loadMoreError', error: errText(e) });
        }
    }

    private async setScope(msg: any, view: vscode.WebviewView): Promise<void> {
        const newScope = String(msg.scope ?? '');
        if (!newScope || newScope === this.scope) { return; }
        const gen = ++this.sessionGen;
        try {
            this.scope = newScope;
            this.layoutState = createLayoutState();
            this.currentSvgWidth = LANE_W;
            this.loadedCount = 0;
            const page = await this.fetchCommits(this.scope, 0, HistoryViewProvider.PAGE_SIZE);
            if (gen !== this.sessionGen) { return; }
            const pageLayouts = computeLayout(page, this.layoutState, !!this.filePath);
            this.bumpSvgWidth(pageLayouts);
            this.loadedCount = page.length;
            view.webview.postMessage({
                type: 'resetCommits',
                scope: this.scope,
                rowsHtml: renderCommitRows(page, pageLayouts, this.currentSvgWidth),
                svgWidth: this.currentSvgWidth,
                loadedCount: this.loadedCount,
                hasMore: page.length === HistoryViewProvider.PAGE_SIZE,
            });
        } catch (e: any) {
            view.webview.postMessage({ type: 'loadMoreError', error: errText(e) });
        }
    }

    // Re-scope this same docked view to a single file's history.
    private async openFileHistory(msg: any, repo: Repository): Promise<void> {
        const ref = (this.scope === HistoryViewProvider.ALL_SENTINEL ? this.fullRef : this.scope) || this.fullRef;
        const fp = msg.filePath ?? msg.path;
        if (fp) { await this.show(repo, ref, String(fp)); }
    }

    private async commitAction(msg: any, repo: Repository): Promise<void> {
        const action = String(msg?.action ?? '');
        // `git reset` only acts on the checked-out branch. It does NOT require an
        // upstream — `git reset <hash>` works on the current branch regardless.
        if (action === 'resetSoft' || action === 'resetHard') {
            const head = repo.state.HEAD;
            if (head?.name !== this.fullRef) {
                vscode.window.showInformationMessage(
                    `Reset is only available for the current branch (${head?.name ?? 'HEAD'}). The history view is showing "${this.fullRef}".`
                );
                return;
            }
        }
        await handleCommitAction(repo, msg);
        // Revert / cherry-pick / create-branch / checkout change the committed
        // history (or move HEAD). Reset rewrites the checked-out branch's history.
        // Reload the list so the change is visible — otherwise the operation
        // succeeds silently and looks like "nothing happened".
        if (HistoryViewProvider.RELOAD_ACTIONS.has(action)) {
            await this.loadSession(repo, this.fullRef, this.filePath);
        }
    }

    private async exportPatch(msg: any, repo: Repository): Promise<void> {
        const hashes = Array.isArray(msg.hashes) ? msg.hashes.map(String).filter(Boolean) : [];
        try {
            await exportPatches(repo, hashes, this.filePath);
        } catch (e: any) {
            vscode.window.showErrorMessage(errText(e));
        }
    }

    // Export the diff between the selected commit and the live working tree (the
    // same comparison shown in the bottom panel in worktree mode).
    private async exportWorktreePatch(msg: any, repo: Repository): Promise<void> {
        const hash = String(msg.hash ?? '');
        if (!hash) { return; }
        try {
            await exportWorktreePatch(repo, hash, this.filePath);
        } catch (e: any) {
            vscode.window.showErrorMessage(errText(e));
        }
    }

    // GET restores the LEFT (old) side of the file comparison to the working tree
    // (the left side is the "before" version shown in the diff):
    //   normal mode (commit vs parent)   → left = parent
    //   worktree mode (commit vs working) → left = commit (= hash)
    private async getFile(msg: any, repo: Repository, view: vscode.WebviewView): Promise<void> {
        const hash = String(msg.hash ?? '');
        const parent = String(msg.parent ?? '');
        const files = Array.isArray(msg.files) ? msg.files : [];
        const compareWorktree = !!msg.compareWorktree;
        if (!hash || files.length === 0) { return; }
        const leftSource = compareWorktree ? hash : (parent || hash);
        const done: string[] = [];
        const removed: string[] = [];
        const skipped: string[] = [];
        try {
            for (const f of files) {
                const p = String(f?.path ?? '');
                if (!p) { continue; }
                const status = String(f?.status ?? '');
                if (compareWorktree) {
                    // getChangedFilesVsWorktree keeps git's own status ('A' = present
                    // only in the working tree, 'D' = deleted from it). 'A' → delete it
                    // so the tree matches the commit; anything else ('D','M','R','C') →
                    // present in / differs from the commit → restore from the commit.
                    if (status === 'A') {
                        // Permanently delete the worktree-only file (no trash).
                        await vscode.workspace.fs.delete(
                            vscode.Uri.file(path.join(repo.rootUri.fsPath, p)),
                            { recursive: false, useTrash: false }
                        );
                        removed.push(p);
                        continue;
                    }
                } else if (status === 'A') {
                    // Normal mode (commit vs parent): 'A' was added on the commit's
                    // side, so its parent version doesn't exist — nothing to restore.
                    skipped.push(p);
                    continue;
                }
                // For renames/copies the left/old file lives at oldPath.
                const leftPath = (status === 'R' || status === 'C') && f?.oldPath
                    ? String(f.oldPath) : p;
                await getFileFromCommit(repo, leftSource, leftPath);
                done.push(p);
            }
            if (done.length > 0) {
                const label = done.length === 1 ? `"${done[0]}"` : `${done.length} files`;
                vscode.window.showInformationMessage(`Got ${label} — local file(s) overwritten.`);
            }
            if (removed.length > 0) {
                const label = removed.length === 1 ? `"${removed[0]}"` : `${removed.length} files`;
                vscode.window.showInformationMessage(`Removed ${label} (only in working tree).`);
            }
            if (skipped.length > 0) {
                vscode.window.showInformationMessage(
                    `Skipped (added — no old version): ${skipped.join(', ')}`
                );
            }
            // In working-tree compare mode, re-pull the file list so the just
            // overwritten files drop out of the diff and the panel reflects the
            // new local state.
            if (compareWorktree) {
                const newFiles = await getChangedFilesVsWorktree(repo, hash, this.filePath);
                view.webview.postMessage({ type: 'files', hash, files: newFiles });
            }
        } catch (e: any) {
            vscode.window.showErrorMessage('Failed to GET file(s): ' + errText(e));
        }
    }

    private async copyHashes(msg: any): Promise<void> {
        const hashes = Array.isArray(msg.hashes) ? msg.hashes.map(String).filter(Boolean) : [];
        if (hashes.length > 0) {
            await vscode.env.clipboard.writeText(hashes.join('\n'));
            vscode.window.showInformationMessage(`Copied ${hashes.length} commit hash(es).`);
        }
    }
}

/**
 * Wire up the docked Git History WebviewView provider plus the commands that
 * drive it (`openHistory` from the branches/tags tree, `gitHistory` from the
 * editor / explorer). The provider instance is created once and reused by both
 * commands so `show()` always talks to the resolved webview.
 */
export function registerHistoryView(
    context: vscode.ExtensionContext,
    historyView: HistoryViewProvider,
    gitApi: GitApi,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('gitBranches.openHistory', async (item?: BranchItem) => {
            if (!item) { return; }
            await historyView.show(item.repo, item.ref.name ?? '', undefined);
        })
    );

    // Open the bottom-panel history scoped to the selected file or folder. A
    // single "Git History" command drives both: when invoked from the editor or
    // Explorer context menu VS Code passes the resource Uri, and we derive the
    // relative path (a folder resolves to an empty path → full repo history).
    // Falls back to the active editor for command-palette invocation.
    context.subscriptions.push(
        vscode.commands.registerCommand('gitBranches.gitHistory', async (arg?: unknown) => {
            const uri = (arg instanceof vscode.Uri ? arg : undefined)
                ?? vscode.window.activeTextEditor?.document.uri;
            if (!uri || uri.scheme !== 'file') {
                vscode.window.showWarningMessage('Open a file or folder on disk first to view its git history.');
                return;
            }
            const repo = findRepoForFile(gitApi.repositories, uri);
            if (!repo) {
                vscode.window.showWarningMessage('This item is not inside an open git repository.');
                return;
            }
            const rel = path.relative(repo.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
            if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
                vscode.window.showWarningMessage('This item is not inside an open git repository.');
                return;
            }
            // An empty relative path means the selection *is* the repository root:
            // show the full repository history (no path filter).
            const ref = repo.state.HEAD?.name ?? 'HEAD';
            await historyView.show(repo, ref, rel || undefined);
        })
    );
}
