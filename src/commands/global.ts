// Global toolbar / multi-repo-visibility commands. These are not tied to a
// branch/tag tree node, so they register directly on the extension context.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RepoItem } from '../branchTreeProvider';
import { runGit } from '../git/gitClient';
import { findRepoForFile, pickRepo, triggerRefresh, withProgress } from '../shared/ui';
import type { RegisterCtx } from './context';

export function registerGlobal(ctx: RegisterCtx): void {
    const { context, gitApi, hiddenRepos } = ctx;

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.fetchAll', async () => {
        const repos = gitApi.repositories;
        await withProgress('Fetching all remotes...', async () => {
            const results = await Promise.allSettled(repos.map(r => r.fetch()));
            results.forEach((r, i) => {
                if (r.status === 'rejected') {
                    const name = repos[i].rootUri.path.split('/').pop() ?? 'unknown';
                    const msg = String(r.reason?.stderr ?? r.reason?.message ?? r.reason).trim();
                    vscode.window.showErrorMessage(`Fetch failed (${name}): ${msg}`);
                }
            });
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.createBranch', async () => {
        const repos = gitApi.repositories;
        if (repos.length === 0) { return; }
        const repo = repos.length === 1 ? repos[0] : await pickRepo(repos);
        if (!repo) { return; }

        const name = await vscode.window.showInputBox({
            prompt: 'New branch name (from current HEAD)',
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!name) { return; }
        await withProgress(`Creating branch ${name}...`, () =>
            repo.createBranch(name.trim(), true)
        );
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.applyPatch', async () => {
        const repos = gitApi.repositories;
        if (repos.length === 0) { return; }
        const repo = repos.length === 1 ? repos[0] : await pickRepo(repos);
        if (!repo) { return; }

        // Choose the patch source: a file on disk, or the current clipboard contents.
        const source = await vscode.window.showQuickPick(
            [
                { label: '选择补丁文件…', description: '从磁盘选择 .patch / .diff 文件', value: 'file' as const },
                { label: '从剪贴板粘贴', description: '使用当前剪贴板中的补丁内容', value: 'clipboard' as const },
            ],
            { placeHolder: '补丁来源' }
        );
        if (!source) { return; }

        let patchPath: string | undefined;
        if (source.value === 'file') {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'Patch files': ['patch', 'diff'], 'All files': ['*'] },
                title: '选择要应用的补丁文件',
                defaultUri: repo.rootUri,
            });
            if (!picked || picked.length === 0) { return; }
            patchPath = picked[0].fsPath;
        } else {
            const clip = await vscode.env.clipboard.readText();
            if (!clip.trim()) {
                vscode.window.showErrorMessage('剪贴板为空，没有可应用的补丁内容。');
                return;
            }
            patchPath = path.join(os.tmpdir(), `git-branches-patch-${Date.now()}.patch`);
            await fs.promises.writeFile(patchPath, clip, 'utf8');
        }

        // Choose how to apply: plain apply, 3-way merge on conflict, or as a commit (git am).
        const mode = await vscode.window.showQuickPick(
            [
                { label: 'git apply', description: '直接应用，遇冲突则整体拒绝（不修改工作区）', value: 'apply' as const },
                { label: 'git apply --3way', description: '冲突时尝试三方合并', value: '3way' as const },
                { label: 'git am', description: '按邮件格式补丁应用为提交（format-patch 输出）', value: 'am' as const },
            ],
            { placeHolder: '选择应用方式' }
        );
        if (!mode) {
            if (source.value === 'clipboard' && patchPath) { try { await fs.promises.unlink(patchPath); } catch {} }
            return;
        }

        const args = mode.value === 'am'
            ? ['am', patchPath]
            : (mode.value === '3way' ? ['apply', '--3way', patchPath] : ['apply', patchPath]);

        try {
            const result = await withProgress('正在应用补丁…', () => runGit(repo, args));
            if (result !== undefined) {
                vscode.window.showInformationMessage(
                    mode.value === 'am' ? '补丁已应用为一个提交。' : '补丁已应用到工作区。'
                );
            }
        } finally {
            if (source.value === 'clipboard' && patchPath) {
                try { await fs.promises.unlink(patchPath); } catch {}
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.refresh', async () => {
        await triggerRefresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.stageCurrentFile', async (uri?: vscode.Uri) => {
        // When invoked from the editor context menu the clicked file's URI is
        // passed as the first argument; otherwise fall back to the active editor.
        const targetUri = uri
            ?? vscode.window.activeTextEditor?.document.uri;
        if (!targetUri || targetUri.scheme !== 'file') {
            vscode.window.showInformationMessage('暂存文件：没有可暂存的文件。');
            return;
        }

        const repo = findRepoForFile(gitApi.repositories, targetUri);
        if (!repo) {
            vscode.window.showInformationMessage('暂存文件：该文件不在任何已打开的 Git 仓库中。');
            return;
        }

        const relPath = path.relative(repo.rootUri.fsPath, targetUri.fsPath);
        await withProgress(`正在暂存 ${targetUri.fsPath.split(/[\\/]/).pop()} …`, () =>
            runGit(repo, ['add', '--', relPath])
        );
    }));

    // ---- Multi-repo visibility ----

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.hideRepository', async (item?: RepoItem) => {
        if (!item) {
            const visible = gitApi.repositories.filter(r => !hiddenRepos.isHidden(r));
            if (visible.length === 0) { return; }
            const picked = await vscode.window.showQuickPick(
                visible.map(r => ({ label: r.rootUri.path.split('/').pop() ?? r.rootUri.fsPath, description: r.rootUri.fsPath, repo: r })),
                { placeHolder: 'Hide repository from Git Branches view' }
            );
            if (!picked) { return; }
            await hiddenRepos.hide(picked.repo);
            return;
        }
        await hiddenRepos.hide(item.repo);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.showHiddenRepository', async () => {
        const paths = hiddenRepos.paths();
        if (paths.length === 0) {
            vscode.window.showInformationMessage('No hidden repositories.');
            return;
        }
        const items = paths.map(p => ({ label: p.split('/').pop() ?? p, description: p, fsPath: p }));
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Show hidden repository', canPickMany: false });
        if (!picked) { return; }
        await hiddenRepos.show(picked.fsPath);
    }));
}
