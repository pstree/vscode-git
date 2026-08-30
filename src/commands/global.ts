// Global toolbar / multi-repo-visibility commands. These are not tied to a
// branch/tag tree node, so they register directly on the extension context.

import * as path from 'path';
import * as vscode from 'vscode';
import { execFileAsync, getGitPath, runGit } from '../git/gitClient';
import { errText, findRepoForFile, pickRepoOrSingle, withProgress } from '../shared/ui';
import type { RegisterCtx } from './context';

export function registerGlobal(ctx: RegisterCtx): void {
    const { context, gitApi } = ctx;

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.fetchAll', async () => {
        const repos = gitApi.repositories;
        await withProgress('Fetching all remotes...', async () => {
            const results = await Promise.allSettled(repos.map(r => r.fetch()));
            results.forEach((r, i) => {
                if (r.status === 'rejected') {
                    const name = repos[i].rootUri.path.split('/').pop() ?? 'unknown';
                    const msg = errText(r.reason);
                    vscode.window.showErrorMessage(`Fetch failed (${name}): ${msg}`);
                }
            });
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.createBranch', async () => {
        const repo = await pickRepoOrSingle(gitApi.repositories);
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
        const repo = await pickRepoOrSingle(gitApi.repositories);
        if (!repo) { return; }

        // Always apply from a patch file on disk. The user opens the file picker directly.
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Patch files': ['patch', 'diff'], 'All files': ['*'] },
            title: '选择要应用的补丁文件',
            defaultUri: repo.rootUri,
        });
        if (!picked || picked.length === 0) { return; }
        const patchPath = picked[0].fsPath;

        // `git apply --3way`: on conflict it writes conflict markers into the working
        // tree (and non-conflicting hunks are applied), so the changes are left in the
        // SCM file-changes area for the user to resolve there. No `git am` — we never
        // create a commit automatically.
        const args = ['apply', '--3way', patchPath];

        try {
            const result = await withProgress('正在应用补丁…', async () => {
                try {
                    return await runGit(repo, args);
                } catch (e: any) {
                    // git apply --3way 遇冲突会以非零退出码报错，但冲突/合并后的内容
                    // 已经写入工作区，不应硬失败。
                    const msg = errText(e);
                    if (!/conflict/i.test(msg)) { throw e; }
                    return undefined;
                }
            });
            // 刷新内置 Git SCM，让应用/冲突产生的文件变更出现在更改区。
            await repo.status().catch(() => {});
            if (result !== undefined) {
                vscode.window.showInformationMessage('补丁已应用到工作区。');
            } else {
                vscode.window.showWarningMessage(
                    '补丁存在冲突，已应用无冲突的部分并把冲突标记写入工作区，请在源代码管理更改区中手动解决。'
                );
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(errText(e));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.updateAll', async () => {
        const repos = gitApi.repositories;
        if (repos.length === 0) { return; }

        // Only update each repository's current (checked-out) branch: pull its
        // upstream into the working tree. Other local branches and remote
        // branches are left untouched. Pull/merge conflicts stay in the working
        // tree so the user can resolve them in the SCM changes area.
        let updated = 0;
        let conflicts = 0;
        await withProgress('更新全部本地分支…', async () => {
            for (const repo of repos) {
                const head = repo.state.HEAD?.name;
                if (!head) { continue; }

                // Resolve the current branch's upstream as "remote/remoteBranch".
                let upstream: string;
                try {
                    const { stdout } = await execFileAsync(
                        getGitPath(),
                        ['rev-parse', '--abbrev-ref', `${head}@{upstream}`],
                        { cwd: repo.rootUri.fsPath }
                    );
                    upstream = stdout.trim();
                } catch {
                    continue; // no upstream — leave branch untouched
                }
                const slashIdx = upstream.indexOf('/');
                const remote = upstream.slice(0, slashIdx);
                const remoteBranch = upstream.slice(slashIdx + 1);

                try {
                    await runGit(repo, ['pull', '--no-edit', remote, remoteBranch]);
                    updated++;
                } catch (e: any) {
                    // Pull produced conflict markers in the working tree — leave
                    // them in place for manual resolution in the SCM changes area.
                    const msg = errText(e);
                    if (/conflict/i.test(msg)) { conflicts++; }
                    else { throw e; }
                }
            }
            // Refresh the built-in Git SCM so pulled changes (and any conflict
            // markers) appear in the changes area.
            for (const repo of repos) { try { await repo.status(); } catch {} }
        });

        if (conflicts > 0) {
            vscode.window.showWarningMessage(
                `更新完成：${updated} 个当前分支已更新，${conflicts} 个存在冲突，请在源代码管理更改区中手动解决。`
            );
        } else {
            vscode.window.showInformationMessage(`更新完成：${updated} 个当前分支已更新。`);
        }
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
}
