// The bottom-panel "Git History" webview view.
//
// Hosts the branch-history commit graph as a docked WebviewView (alongside
// Terminal / Output / Problems). The view is reused across invocations: each
// "View History" call re-scopes the same view instead of opening a new tab.
// `context`/`gitApi` are injected via the constructor; everything else comes
// from the sibling modules.

import * as path from 'path';
import * as vscode from 'vscode';
import type { BranchItem } from '../branchTreeProvider';
import { GitApi, Repository } from '../gitApi';
import { getDict, resolveLang, t } from '../shared/i18n';
import { errText, findRepoForFile } from '../shared/ui';

import { execFileAsync, getChangedFiles, getChangedFilesBetween, getChangedFilesVsWorktree, getCommitDiff, getFileFromCommit, getGitPath, SHOW_MAX_BUFFER } from '../git/gitClient';
import { exportPatches, exportWorktreePatch, handleCommitAction } from './commitActions';
import { openCommitFileDiff, openCompareWithWorktree, openRangeFileDiff } from './commitFileProvider';
import { CommitData, computeLayout, createLayoutState, LANE_W, renderCommitRows, RowLayout } from './graph';
import { buildHistoryHtml, errorHistoryHtml, placeholderHistoryHtml } from './historyHtml';

export const HISTORY_VIEW_TYPE = 'gitBranches.historyView';

// Merge order for all-projects mode: committer timestamp descending, hash as a
// stable tie-break for identical timestamps.
const isNewerCommit = (a: CommitData, b: CommitData): boolean =>
    (a.ts ?? 0) !== (b.ts ?? 0) ? (a.ts ?? 0) > (b.ts ?? 0) : a.hash < b.hash;

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
        if (this.allMode) {
            await this.loadAll();
        } else if (this.repo && this.fullRef) {
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
    private static readonly ALL_REPOS_SENTINEL = '__ALL_REPOS__';
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
    // Bumped whenever loadSession()/setScope()/loadAll() starts a new scope. In-flight
    // async loads capture the generation before awaiting and abandon their
    // result if it changed, so a late response can't corrupt the new scope.
    private sessionGen = 0;
    // "All projects" mode: one merged history across every open repository.
    // Commits are fetched per repo and k-way merged by committer timestamp
    // (topo-order is meaningless across repositories). `allRepos` snapshots the
    // repositories at session start so the per-repo pagination cursors stay stable.
    private allMode = false;
    private allRepos: Repository[] = [];
    private allRepoCursor = new Map<string, number>();
    private allRepoBuffer = new Map<string, CommitData[]>();
    private allRepoHasMore = false;

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

    // Distinct author names across `repos` for the same scope/path filter as the
    // commit list, feeding the author filter's suggestion list. Best-effort: a
    // repository that fails to enumerate simply contributes nothing.
    private async listAuthors(repos: Repository[], scope: string, filePath?: string): Promise<string[]> {
        const authors = new Set<string>();
        await Promise.all(repos.map(async repo => {
            try {
                const args = ['log', '--format=%an'];
                if (scope === HistoryViewProvider.ALL_SENTINEL) {
                    args.push('--all');
                } else if (scope) {
                    args.push(scope);
                }
                if (filePath) { args.push('--', filePath); }
                const { stdout } = await execFileAsync(getGitPath(), args, { cwd: repo.rootUri.fsPath, maxBuffer: SHOW_MAX_BUFFER });
                for (const line of stdout.split('\n')) {
                    const name = line.trim();
                    if (name) { authors.add(name); }
                }
            } catch { /* ignore — no authors from this repository */ }
        }));
        return Array.from(authors).sort((a, b) => a.localeCompare(b));
    }

    private async fetchCommits(scope: string, skip: number, count: number): Promise<CommitData[]> {
        if (!this.repo) { return []; }
        return this.fetchCommitsFromRepo(this.repo, scope, skip, count, this.filePath);
    }

    // One `git log` page within a single repository. `filePath` scopes the log to
    // a path (single-repo file history only — all-projects mode has no path).
    private async fetchCommitsFromRepo(repo: Repository, scope: string, skip: number, count: number, filePath?: string): Promise<CommitData[]> {
        const SEP = HistoryViewProvider.SEP;
        const ALL_SENTINEL = HistoryViewProvider.ALL_SENTINEL;
        const args = [
            'log', '--topo-order',
            `--skip=${skip}`,
            `--max-count=${count}`,
            `--date=format-local:%Y-%m-%d %H:%M`,
            // %ct (committer timestamp) orders the merge across repositories.
            `--pretty=format:%H${SEP}%h${SEP}%P${SEP}%D${SEP}%s${SEP}%ad${SEP}%an${SEP}%ct`,
        ];
        if (scope === ALL_SENTINEL) {
            args.push('--all');
        } else {
            args.push(scope);
        }
        if (filePath) { args.push('--', filePath); }
        const { stdout } = await execFileAsync(getGitPath(), args, { cwd: repo.rootUri.fsPath, maxBuffer: SHOW_MAX_BUFFER });
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
                ts:      parseInt(parts[7] ?? '', 10) || 0,
            };
        });
    }

    // Next merged page across every repository (all-projects mode). Each repo
    // keeps its own buffer + skip cursor; before every take each buffer is
    // topped up to `count` items, which guarantees the k-way take of the `count`
    // newest commits (by committer timestamp) is globally ordered across pages.
    private async fetchCommitsAll(count: number): Promise<CommitData[]> {
        await Promise.all(this.allRepos.map(async repo => {
            const key = repo.rootUri.fsPath;
            let buf = this.allRepoBuffer.get(key) ?? [];
            while (buf.length < count) {
                const want = count - buf.length;
                const cursor = this.allRepoCursor.get(key) ?? 0;
                const batch = await this.fetchCommitsFromRepo(repo, HistoryViewProvider.ALL_SENTINEL, cursor, want);
                this.allRepoCursor.set(key, cursor + batch.length);
                buf = buf.concat(batch.map(c => ({ ...c, repoPath: key })));
                if (batch.length < want) { break; } // repo exhausted
            }
            this.allRepoBuffer.set(key, buf);
        }));
        // K-way take: repeatedly emit the newest head across the repo buffers.
        const out: CommitData[] = [];
        const taken = new Map<string, number>();
        while (out.length < count) {
            let bestKey = '';
            let best: CommitData | undefined;
            for (const [key, buf] of this.allRepoBuffer) {
                const head = buf[taken.get(key) ?? 0];
                if (!head) { continue; }
                if (!best || isNewerCommit(head, best)) { best = head; bestKey = key; }
            }
            if (!best) { break; }
            taken.set(bestKey, (taken.get(bestKey) ?? 0) + 1);
            out.push(best);
        }
        // Drop consumed heads; a repo with items left means more pages remain.
        this.allRepoHasMore = false;
        for (const [key, buf] of this.allRepoBuffer) {
            const rest = buf.slice(taken.get(key) ?? 0);
            this.allRepoBuffer.set(key, rest);
            if (rest.length > 0) { this.allRepoHasMore = true; }
        }
        return out;
    }

    private bumpSvgWidth(layouts: RowLayout[]): void {
        const cols = Math.max(1, ...layouts.map(r => Math.max(r.topLanes.length, r.botLanes.length)));
        this.currentSvgWidth = Math.max(this.currentSvgWidth, cols * LANE_W);
    }

    // (Re)load the view with the history of `fullRef` (optionally a single file).
    private async loadSession(repo: Repository, fullRef: string, filePath?: string): Promise<void> {
        this.allMode = false;
        this.allRepoCursor.clear();
        this.allRepoBuffer.clear();
        this.allRepoHasMore = false;
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
            const [first, branches, authors] = await Promise.all([
                this.fetchCommits(this.scope, 0, HistoryViewProvider.PAGE_SIZE),
                this.listLocalBranches(),
                this.listAuthors([repo], this.scope, this.filePath),
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
                this.repoOptions(), repo.rootUri.fsPath,
                HistoryViewProvider.ALL_REPOS_SENTINEL, false,
                authors,
            );
        } catch (e: any) {
            view.webview.html = errorHistoryHtml(view.webview.cspSource, errText(e));
        }
    }

    // (Re)load the view with the merged history of every open repository
    // ("All projects" in the project dropdown). The commit graph renders flat
    // (lone dots) because commits from different repositories share no topology.
    private async loadAll(): Promise<void> {
        const view = this.view;
        if (!view) { return; }
        this.allMode = true;
        this.repo = undefined;
        this.fullRef = '';
        this.filePath = undefined;
        this.lastHeadName = undefined;
        this.scope = HistoryViewProvider.ALL_SENTINEL;
        this.allRepos = this.gitApi.repositories.slice();
        this.allRepoCursor.clear();
        this.allRepoBuffer.clear();
        this.allRepoHasMore = false;
        this.layoutState = createLayoutState();
        this.currentSvgWidth = LANE_W;
        this.loadedCount = 0;
        const gen = ++this.sessionGen;

        try {
            const [first, authors] = await Promise.all([
                this.fetchCommitsAll(HistoryViewProvider.PAGE_SIZE),
                this.listAuthors(this.allRepos, HistoryViewProvider.ALL_SENTINEL),
            ]);
            if (gen !== this.sessionGen) { return; }
            const firstLayouts = computeLayout(first, this.layoutState, true);
            this.bumpSvgWidth(firstLayouts);
            this.loadedCount = first.length;
            view.webview.html = buildHistoryHtml(
                first, firstLayouts, '', view.webview.cspSource,
                this.currentSvgWidth, this.allRepoHasMore, this.scope, [],
                HistoryViewProvider.ALL_SENTINEL, false, undefined,
                resolveLang(vscode.env.language),
                this.repoOptions(), HistoryViewProvider.ALL_REPOS_SENTINEL,
                HistoryViewProvider.ALL_REPOS_SENTINEL, true,
                authors,
            );
        } catch (e: any) {
            view.webview.html = errorHistoryHtml(view.webview.cspSource, errText(e));
        }
    }

    // Project dropdown entries: one per open repository (folder name; full path as tooltip).
    private repoOptions(): { path: string; name: string }[] {
        return this.gitApi.repositories.map(r => ({
            path: r.rootUri.fsPath,
            name: r.rootUri.fsPath.split(/[\\/]/).pop() || r.rootUri.fsPath,
        }));
    }

    /**
     * Re-load the currently-shown history session if it belongs to the same
     * repository and branch. Invoked after a branch pull completes so the Git
     * History list reflects the newly pulled commits.
     */
    async refreshIfMatches(repo: Repository, refName: string): Promise<void> {
        if (!this.view) { return; }
        if (this.allMode) {
            // Merged view: refresh when the touched repository is part of it.
            if (!this.allRepos.includes(repo)) { return; }
            await this.loadAll();
            return;
        }
        if (!this.repo) { return; }
        if (this.repo.rootUri.fsPath !== repo.rootUri.fsPath) { return; }
        if (this.fullRef !== refName) { return; }
        await this.loadSession(this.repo, this.fullRef, this.filePath);
    }

    // Resolve the repository a webview message refers to. Single-project sessions
    // always use the session repo; all-projects sessions route per commit via the
    // row's `data-repo` (repo root path echoed back by the webview).
    private repoFor(msg: any): Repository | undefined {
        if (!this.allMode) { return this.repo; }
        const p = String(msg?.repo ?? '');
        return this.allRepos.find(r => r.rootUri.fsPath === p);
    }

    private async handleMessage(msg: any): Promise<void> {
        const view = this.view;
        if (!view) { return; }

        // Thin dispatch: each message type maps to one small handler below, so no
        // single method grows into a long if/else chain. Commit-scoped messages
        // carry their owning repo path and resolve through repoFor().
        switch (msg?.type) {
            case 'selectCommit': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.postChangedFiles(view, { type: 'files', hash: msg.hash }, () =>
                    getChangedFiles(repo, msg.hash, msg.parent, this.filePath));
            }
            case 'selectCommitWorktree': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.postChangedFiles(view, { type: 'files', hash: msg.hash }, () =>
                    getChangedFilesVsWorktree(repo, msg.hash, this.filePath));
            }
            case 'selectCommitDiff': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.postChangedFiles(view, { type: 'commitDiff', hash: msg.hash }, () =>
                    getCommitDiff(repo, msg.hash, msg.parent, this.filePath));
            }
            case 'selectRange': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.postChangedFiles(view,
                    { type: 'rangeFiles', fromHash: msg.fromHash, toHash: msg.toHash }, () =>
                        getChangedFilesBetween(repo, msg.fromHash, msg.toHash, this.filePath));
            }
            case 'openCommitDiffTab': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.openCommitDiffTab(msg, repo);
            }
            case 'openFile': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.openFile(msg, repo);
            }
            case 'compareWorktree': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.compareFileWorktree(msg, repo);
            }
            case 'loadMore': return this.loadMore(view);
            case 'setScope': return this.setScope(msg, view);
            case 'setProject': return this.setProject(msg);
            case 'openFileHistory': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.openFileHistory(msg, repo);
            }
            case 'clearFileScope': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.show(repo, this.fullRef, undefined);
            }
            case 'commitAction': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.commitAction(msg, repo);
            }
            case 'exportPatch': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.exportPatch(msg, repo);
            }
            case 'exportWorktreePatch': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.exportWorktreePatch(msg, repo);
            }
            case 'getFile': {
                const repo = this.repoFor(msg);
                if (!repo) { return; }
                return this.getFile(msg, repo, view);
            }
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
        if (this.allMode) { return this.loadMoreAll(view); }
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

    private async loadMoreAll(view: vscode.WebviewView): Promise<void> {
        try {
            const gen = this.sessionGen;
            const next = await this.fetchCommitsAll(HistoryViewProvider.PAGE_SIZE);
            if (gen !== this.sessionGen) { return; }
            const nextLayouts = computeLayout(next, this.layoutState, true);
            this.bumpSvgWidth(nextLayouts);
            this.loadedCount += next.length;
            view.webview.postMessage({
                type: 'moreCommits',
                // All-projects rows carry the extra Project column.
                rowsHtml: renderCommitRows(next, nextLayouts, this.currentSvgWidth, true),
                svgWidth: this.currentSvgWidth,
                added: next.length,
                hasMore: this.allRepoHasMore,
            });
        } catch (e: any) {
            view.webview.postMessage({ type: 'loadMoreError', error: errText(e) });
        }
    }

    private async setScope(msg: any, view: vscode.WebviewView): Promise<void> {
        if (this.allMode) { return; } // branch dropdown is disabled in all-projects mode
        const newScope = String(msg.scope ?? '');
        if (!newScope || newScope === this.scope) { return; }
        const gen = ++this.sessionGen;
        try {
            this.scope = newScope;
            this.layoutState = createLayoutState();
            this.currentSvgWidth = LANE_W;
            this.loadedCount = 0;
            const [page, authors] = await Promise.all([
                this.fetchCommits(this.scope, 0, HistoryViewProvider.PAGE_SIZE),
                this.listAuthors(this.repo ? [this.repo] : [], this.scope, this.filePath),
            ]);
            if (gen !== this.sessionGen) { return; }
            const pageLayouts = computeLayout(page, this.layoutState, !!this.filePath);
            this.bumpSvgWidth(pageLayouts);
            this.loadedCount = page.length;
            view.webview.postMessage({
                type: 'resetCommits',
                scope: this.scope,
                authors,
                rowsHtml: renderCommitRows(page, pageLayouts, this.currentSvgWidth),
                svgWidth: this.currentSvgWidth,
                loadedCount: this.loadedCount,
                hasMore: page.length === HistoryViewProvider.PAGE_SIZE,
            });
        } catch (e: any) {
            view.webview.postMessage({ type: 'loadMoreError', error: errText(e) });
        }
    }

    // Project dropdown: switch to a single repository, or merge every repository.
    // Switching projects drops the file filter (a file path is repo-specific).
    private async setProject(msg: any): Promise<void> {
        const project = String(msg?.project ?? '');
        if (project === HistoryViewProvider.ALL_REPOS_SENTINEL) {
            if (this.allMode) { return; }
            await this.loadAll();
            return;
        }
        const repo = this.gitApi.repositories.find(r => r.rootUri.fsPath === project);
        if (!repo) { return; }
        if (!this.allMode && this.repo?.rootUri.fsPath === project) {
            // Same repository — only re-scope when a file filter is active (clears it).
            if (!this.filePath) { return; }
            await this.show(repo, this.fullRef, undefined);
            return;
        }
        await this.show(repo, repo.state.HEAD?.name ?? 'HEAD', undefined);
    }

    // Re-scope this same docked view to a single file's history.
    private async openFileHistory(msg: any, repo: Repository): Promise<void> {
        const ref = this.allMode
            ? (repo.state.HEAD?.name ?? 'HEAD')
            : ((this.scope === HistoryViewProvider.ALL_SENTINEL ? this.fullRef : this.scope) || this.fullRef);
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
            await this.reloadCurrent();
        }
    }

    // Reload whatever is currently shown: the merged all-projects view, or the
    // single-repo session.
    private async reloadCurrent(): Promise<void> {
        if (this.allMode) {
            await this.loadAll();
        } else if (this.repo) {
            await this.loadSession(this.repo, this.fullRef, this.filePath);
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
        // The left side of the comparison is the source we restore from: the commit
        // itself in worktree mode, otherwise the parent.
        const leftSource = compareWorktree ? hash : (parent || hash);

        const done: string[] = [];
        const removed: string[] = [];
        const skipped: string[] = [];
        // One-item list → quoted filename, otherwise a count.
        const summarize = (items: string[]) =>
            items.length === 1 ? `"${items[0]}"` : `${items.length} files`;

        try {
            for (const f of files) {
                const p = String(f?.path ?? '');
                const status = String(f?.status ?? '');
                if (!p) { continue; }
                if (status === 'A') {
                    if (compareWorktree) {
                        // 'A' = present only in the working tree (not in the commit) →
                        // delete it so the tree matches the commit.
                        await vscode.workspace.fs.delete(
                            vscode.Uri.file(path.join(repo.rootUri.fsPath, p)),
                            { recursive: false, useTrash: false }
                        );
                        removed.push(p);
                    } else {
                        // Normal mode: 'A' was added on the commit's side, so its parent
                        // version doesn't exist — nothing to restore.
                        skipped.push(p);
                    }
                    continue;
                }
                // For renames/copies the left/old file lives at oldPath.
                const leftPath = (status === 'R' || status === 'C') && f?.oldPath
                    ? String(f.oldPath) : p;
                await getFileFromCommit(repo, leftSource, leftPath);
                done.push(p);
            }
            if (done.length > 0) {
                vscode.window.showInformationMessage(`Got ${summarize(done)} — local file(s) overwritten.`);
            }
            if (removed.length > 0) {
                vscode.window.showInformationMessage(`Removed ${summarize(removed)} (only in working tree).`);
            }
            if (skipped.length > 0) {
                vscode.window.showInformationMessage(`Skipped (added — no old version): ${skipped.join(', ')}`);
            }
            // In worktree mode re-pull the list so the just-overwritten files drop
            // out of the diff and the panel reflects the new local state.
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
