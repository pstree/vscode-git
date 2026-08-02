// Local + remote branch commands.
//
// Every handler here operates on a `BranchItem` (a tree node) and is wired via
// the shared `reg` helper. Git I/O goes through `../git/gitClient`; user prompts
// through `../shared/ui`.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Branch } from '../gitApi';
import type { RegisterCtx } from './context';
import { confirm, triggerRefresh, withProgress } from '../shared/ui';
import { execFileAsync, getGitPath, parseRemoteBranch, runGit, SHOW_MAX_BUFFER } from '../git/gitClient';

export function registerBranches(ctx: RegisterCtx): void {
    const { reg } = ctx;

    // Inline refresh icon on each branch row: pull (fast-forward) the branch to
    // its upstream so the Git History list — if showing this branch — reflects
    // the newly pulled commits. Remote-tracking refs are refreshed via fetch.
    // No-op placeholder for the spinning inline button shown while a pull is
    // in progress. Clicking it should do nothing.
    reg('gitBranches.fetchBranchSpin', async () => {});

    reg('gitBranches.fetchBranch', async (item?) => {
        if (!item) { return; }
        const name = item.ref.name;
        if (!name) { return; }
        const repo = item.repo;

        // Spin the row's refresh icon while pulling.
        ctx.branchesProvider?.setBranchLoading(repo, name, true);
        try {
            if (item.contextValue === 'remoteBranch') {
                // Remote-tracking ref: "pull" here just refreshes the ref via fetch.
                const { remote, branch } = parseRemoteBranch(repo, item.ref);
                await withProgress(`Pulling ${branch} from ${remote}...`, () =>
                    repo.fetch(remote, branch)
                );
                return;
            }

            // Local branch: pull it to its upstream — `git pull` for the current
            // branch, `git fetch <remote> <remoteBranch>:<name>` (fast-forward) for
            // a non-current branch.
            const isCurrent = repo.state.HEAD?.name === name;
            if (isCurrent) {
                if (!repo.state.HEAD?.upstream) {
                    vscode.window.showErrorMessage(`"${name}" has no upstream configured. Use Set Upstream first.`);
                    return;
                }
                await withProgress(`Pulling ${name}...`, () => repo.pull());
            } else {
                let upstreamRef: string;
                try {
                    const { stdout } = await execFileAsync(
                        getGitPath(),
                        ['rev-parse', '--abbrev-ref', `${name}@{upstream}`],
                        { cwd: repo.rootUri.fsPath }
                    );
                    upstreamRef = stdout.trim();
                } catch {
                    vscode.window.showErrorMessage(`"${name}" has no upstream configured. Use Set Upstream first.`);
                    return;
                }
                const slashIdx = upstreamRef.indexOf('/');
                const remote = upstreamRef.slice(0, slashIdx);
                const remoteBranch = upstreamRef.slice(slashIdx + 1);
                await withProgress(`Pulling ${name}...`, () =>
                    runGit(repo, ['fetch', remote, `${remoteBranch}:${name}`])
                );
            }
        } finally {
            ctx.branchesProvider?.setBranchLoading(repo, name, false);
        }
        // Branch just pulled/updated: if Git History is showing this same branch,
        // reload it so the freshly-pulled commits appear in the list.
        ctx.historyView?.refreshIfMatches(repo, name);
    });

    // Inline push icon (↑) shown for local branches that have no upstream yet:
    // push the branch and set its upstream so pull/reset become available.
    reg('gitBranches.fetchBranchPush', async (item?) => {
        if (!item) { return; }
        const name = item.ref.name;
        if (!name) { return; }
        const repo = item.repo;

        const remotes = repo.state.remotes;
        if (remotes.length === 0) {
            vscode.window.showErrorMessage('No remotes configured.');
            return;
        }
        const remoteName = remotes.find(r => r.name === 'origin')?.name ?? remotes[0].name;

        ctx.branchesProvider?.setBranchLoading(repo, name, true);
        try {
            await withProgress(`Pushing ${name} and setting upstream...`, () =>
                runGit(repo, ['push', '-u', remoteName, name])
            );
        } finally {
            ctx.branchesProvider?.setBranchLoading(repo, name, false);
        }
        // Branch now has an upstream: if Git History is showing this branch,
        // re-enable Reset by reloading the list.
        ctx.historyView?.refreshIfMatches(repo, name);
    });

    reg('gitBranches.update', async (item?) => {
        if (!item) { return; }
        const isCurrent = item.repo.state.HEAD?.name === item.ref.name;

        if (isCurrent) {
            // Current branch: repo.state.HEAD.upstream is always reliable
            if (!item.repo.state.HEAD?.upstream) {
                vscode.window.showErrorMessage(`"${item.ref.name}" has no upstream configured. Use Set Upstream first.`);
                return;
            }
            await withProgress(`Updating ${item.ref.name}...`, () => item.repo.pull());
            return;
        }

        // Non-current branch: getBranches() may not populate upstream in all VS Code versions,
        // so resolve it directly from git as a reliable fallback.
        let upstreamRef: string;
        try {
            const { stdout } = await execFileAsync(
                getGitPath(),
                ['rev-parse', '--abbrev-ref', `${item.ref.name}@{upstream}`],
                { cwd: item.repo.rootUri.fsPath }
            );
            upstreamRef = stdout.trim(); // e.g. "origin/feature-3.0.0"
        } catch {
            vscode.window.showErrorMessage(`"${item.ref.name}" has no upstream configured. Use Set Upstream first.`);
            return;
        }

        const slashIdx = upstreamRef.indexOf('/');
        const remote = upstreamRef.slice(0, slashIdx);
        const remoteBranch = upstreamRef.slice(slashIdx + 1);
        await withProgress(`Updating ${item.ref.name}...`, () =>
            runGit(item.repo, ['fetch', remote, `${remoteBranch}:${item.ref.name}`])
        );
    });

    reg('gitBranches.checkout', async (item?) => {
        if (!item) { return; }
        await withProgress(`Checking out ${item.ref.name}...`, () =>
            item.repo.checkout(item.ref.name!)
        );
    });

    reg('gitBranches.merge', async (item?) => {
        if (!item) { return; }

        const strategies = [
            { label: 'Merge', description: 'Create a merge commit', value: 'merge' as const },
            { label: 'Squash and Merge', description: 'Squash all commits into one staged change', value: 'squash' as const },
            { label: 'No Fast-Forward', description: 'Always create a merge commit (--no-ff)', value: 'no-ff' as const },
        ];
        const strategy = await vscode.window.showQuickPick(strategies, {
            placeHolder: `Merge "${item.ref.name}" into current branch — select strategy`,
        });
        if (!strategy) { return; }

        const ok = await confirm(`${strategy.label} "${item.ref.name}" into current branch?`, strategy.label);
        if (!ok) { return; }

        await withProgress(`Merging ${item.ref.name}...`, async () => {
            if (strategy.value === 'squash') {
                await runGit(item.repo, ['merge', '--squash', item.ref.name!]);
                vscode.window.showInformationMessage(
                    `"${item.ref.name}" squashed and staged. Commit to complete the merge.`
                );
            } else if (strategy.value === 'no-ff') {
                await runGit(item.repo, ['merge', '--no-ff', '--no-edit', item.ref.name!]);
            } else {
                await item.repo.merge(item.ref.name!);
            }
        });
    });

    reg('gitBranches.rebase', async (item?) => {
        if (!item) { return; }
        const ok = await confirm(
            `Rebase current branch onto "${item.ref.name}"? This rewrites history.`,
            'Rebase'
        );
        if (!ok) { return; }
        await withProgress(`Rebasing onto ${item.ref.name}...`, () =>
            runGit(item.repo, ['rebase', item.ref.name!])
        );
    });

    reg('gitBranches.checkoutAndRebase', async (item?) => {
        if (!item) { return; }
        const currentBranch = item.repo.state.HEAD?.name;
        if (!currentBranch) {
            vscode.window.showErrorMessage('No current branch.');
            return;
        }
        const ok = await confirm(
            `Checkout "${item.ref.name}" and rebase it onto "${currentBranch}"? This rewrites history.`,
            'Checkout and Rebase'
        );
        if (!ok) { return; }
        await withProgress(`Rebasing ${item.ref.name} onto ${currentBranch}...`, async () => {
            await item.repo.checkout(item.ref.name!);
            try {
                await runGit(item.repo, ['rebase', currentBranch]);
            } catch (e: any) {
                const msg = String(e.stderr ?? e.message ?? e);
                if (msg.includes('conflict') || msg.includes('CONFLICT')) {
                    vscode.window.showWarningMessage(
                        'Rebase has conflicts. Resolve them, then run "git rebase --continue". To cancel: "git rebase --abort".'
                    );
                } else {
                    throw e;
                }
            }
        });
    });

    reg('gitBranches.rename', async (item?) => {
        if (!item) { return; }
        const newName = await vscode.window.showInputBox({
            prompt: 'New branch name',
            value: item.ref.name,
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!newName || newName === item.ref.name) { return; }
        await withProgress(`Renaming branch...`, () =>
            runGit(item.repo, ['branch', '-m', item.ref.name!, newName.trim()])
        );
    });

    reg('gitBranches.push', async (item?) => {
        if (!item) { return; }
        // Use the branch's configured upstream remote, or ask the user
        let remoteName = (item.ref as Branch).upstream?.remote;
        if (!remoteName) {
            const remotes = item.repo.state.remotes;
            if (remotes.length === 0) {
                vscode.window.showErrorMessage('No remotes configured.');
                return;
            }
            if (remotes.length === 1) {
                remoteName = remotes[0].name;
            } else {
                const picked = await vscode.window.showQuickPick(
                    remotes.map(r => ({ label: r.name, description: r.pushUrl ?? r.fetchUrl })),
                    { placeHolder: 'Select remote to push to' }
                );
                if (!picked) { return; }
                remoteName = picked.label;
            }
        }
        await withProgress(`Pushing ${item.ref.name} to ${remoteName}...`, () =>
            item.repo.push(remoteName, item.ref.name, true)
        );
    });

    reg('gitBranches.setUpstream', async (item?) => {
        if (!item) { return; }
        const remotes = item.repo.state.remotes;
        if (remotes.length === 0) {
            vscode.window.showErrorMessage('No remotes configured.');
            return;
        }
        const pickedRemote = await vscode.window.showQuickPick(
            remotes.map(r => ({ label: r.name, description: r.fetchUrl })),
            { placeHolder: 'Select remote to track' }
        );
        if (!pickedRemote) { return; }
        const remoteBranchName = await vscode.window.showInputBox({
            prompt: `Remote branch name on "${pickedRemote.label}"`,
            value: item.ref.name,
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!remoteBranchName) { return; }
        const upstream = `${pickedRemote.label}/${remoteBranchName.trim()}`;
        await withProgress(`Setting upstream to ${upstream}...`, () =>
            runGit(item.repo, ['branch', `--set-upstream-to=${upstream}`, item.ref.name!])
        );
    });

    reg('gitBranches.createFrom', async (item?) => {
        if (!item) { return; }
        const newName = await vscode.window.showInputBox({
            prompt: `New branch name (from ${item.ref.name})`,
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!newName) { return; }
        await withProgress(`Creating branch ${newName}...`, () =>
            item.repo.createBranch(newName.trim(), true, item.ref.name)
        );
    });

    reg('gitBranches.deleteLocal', async (item?) => {
        if (!item) { return; }
        const ok = await confirm(`Delete local branch "${item.ref.name}"?`, 'Delete');
        if (!ok) { return; }
        // Try a normal delete; on "not fully merged" offer force delete outside the progress toast.
        let notFullyMerged = false;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Deleting branch ${item.ref.name}...` },
            async () => {
                try {
                    await item.repo.deleteBranch(item.ref.name!, false);
                    await triggerRefresh();
                } catch (e: any) {
                    const msg = String(e.stderr ?? e.message ?? e);
                    if (msg.includes('not fully merged')) {
                        notFullyMerged = true;
                    } else {
                        vscode.window.showErrorMessage(msg.trim());
                    }
                }
            }
        );
        if (notFullyMerged) {
            const force = await confirm(
                `"${item.ref.name}" is not fully merged. Force delete?`,
                'Force Delete'
            );
            if (!force) { return; }
            await withProgress(`Force deleting branch ${item.ref.name}...`, () =>
                item.repo.deleteBranch(item.ref.name!, true)
            );
        }
    });

    reg('gitBranches.createPatch', async (item?) => {
        if (!item) { return; }
        const baseBranch = item.ref.name;
        if (!baseBranch) {
            vscode.window.showErrorMessage('所选分支没有名称。');
            return;
        }
        const currentBranch = item.repo.state.HEAD?.name;

        // Pick the diff scope: the working tree (local current code, incl. uncommitted)
        // vs the base branch, or just the committed changes (HEAD vs base).
        const scope = await vscode.window.showQuickPick(
            [
                {
                    label: '工作区改动（含未提交）',
                    description: 'git diff <branch> — 当前工作区代码相对该分支的全部差异',
                    value: 'worktree' as const,
                },
                {
                    label: '仅已提交改动',
                    description: 'git diff <branch> HEAD — 当前分支已提交内容相对该分支的差异',
                    value: 'committed' as const,
                },
            ],
            { placeHolder: `生成补丁的范围（基准分支：${baseBranch}）` }
        );
        if (!scope) { return; }

        const args = scope.value === 'committed'
            ? ['diff', '-M', '-U3', baseBranch, 'HEAD']
            : ['diff', '-M', '-U3', baseBranch];

        let patch: string;
        try {
            const { stdout } = await execFileAsync(getGitPath(), args, {
                cwd: item.repo.rootUri.fsPath,
                maxBuffer: SHOW_MAX_BUFFER,
            });
            patch = stdout;
        } catch (e: any) {
            vscode.window.showErrorMessage(String(e.stderr ?? e.message ?? e).trim());
            return;
        }
        if (!patch.trim()) {
            vscode.window.showInformationMessage(`"${baseBranch}" 与当前代码没有差异，未生成补丁。`);
            return;
        }

        const dest = await vscode.window.showQuickPick(
            [
                { label: '保存到文件并打开', description: '写入 .patch 文件并在编辑器中打开' },
                { label: '复制到剪贴板', description: '将补丁内容复制到剪贴板' },
            ],
            { placeHolder: '生成补丁后如何输出？' }
        );
        if (!dest) { return; }

        if (dest.label.startsWith('复制到')) {
            await vscode.env.clipboard.writeText(patch);
            vscode.window.showInformationMessage('补丁内容已复制到剪贴板。');
            return;
        }

        // Save to a .patch file (relative paths resolve against the repo root).
        const root = item.repo.rootUri.fsPath;
        const defaultName = `${(currentBranch ?? 'worktree')}-vs-${baseBranch}.patch`.replace(/[\\/:*?"<>|]/g, '_');
        const input = await vscode.window.showInputBox({
            prompt: '补丁文件保存路径（仓库根目录下的文件名或绝对路径）',
            value: path.join(root, defaultName),
            validateInput: v => v.trim() ? undefined : '路径不能为空',
        });
        if (!input) { return; }
        const targetPath = path.isAbsolute(input) ? input : path.join(root, input);
        await fs.promises.writeFile(targetPath, patch, 'utf8');
        const doc = await vscode.workspace.openTextDocument(targetPath);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(`补丁已保存：${targetPath}`);
    });

    // ---- Remote branch commands ----

    reg('gitBranches.checkoutRemote', async (item?) => {
        if (!item) { return; }
        const { remote, branch } = parseRemoteBranch(item.repo, item.ref);
        const localName = await vscode.window.showInputBox({
            prompt: 'Local branch name',
            value: branch,
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!localName) { return; }
        await withProgress(`Checking out ${item.ref.name}...`, () =>
            runGit(item.repo, ['checkout', '-b', localName.trim(), `${remote}/${branch}`])
        );
    });

    reg('gitBranches.pull', async (item?) => {
        if (!item) { return; }
        const { remote, branch } = parseRemoteBranch(item.repo, item.ref);
        await withProgress(`Fetching ${branch} from ${remote}...`, () =>
            item.repo.fetch(remote, branch)
        );
    });

    reg('gitBranches.pullIntoCurrent', async (item?) => {
        if (!item) { return; }
        const { remote, branch } = parseRemoteBranch(item.repo, item.ref);
        const currentBranch = item.repo.state.HEAD?.name;
        if (!currentBranch) {
            vscode.window.showErrorMessage('No current branch.');
            return;
        }

        const strategies = [
            { label: 'Merge', description: `Fetch and merge ${remote}/${branch} into ${currentBranch}`, value: 'merge' as const },
            { label: 'Rebase', description: `Fetch then rebase ${currentBranch} onto ${remote}/${branch}`, value: 'rebase' as const },
        ];
        const strategy = await vscode.window.showQuickPick(strategies, {
            placeHolder: `Pull ${remote}/${branch} into "${currentBranch}"`,
        });
        if (!strategy) { return; }

        await withProgress(`Pulling ${branch} into ${currentBranch}...`, async () => {
            await runGit(item.repo, ['fetch', remote, branch]);
            if (strategy.value === 'merge') {
                await item.repo.merge(`${remote}/${branch}`);
            } else {
                try {
                    await runGit(item.repo, ['rebase', `${remote}/${branch}`]);
                } catch (e: any) {
                    const msg = String(e.stderr ?? e.message ?? e);
                    if (msg.includes('conflict') || msg.includes('CONFLICT')) {
                        vscode.window.showWarningMessage(
                            'Rebase has conflicts. Resolve them, then run "git rebase --continue". To cancel: "git rebase --abort".'
                        );
                    } else {
                        throw e;
                    }
                }
            }
        });
    });

    reg('gitBranches.deleteRemote', async (item?) => {
        if (!item) { return; }
        const { remote, branch } = parseRemoteBranch(item.repo, item.ref);
        const ok = await confirm(
            `Delete remote branch "${branch}" on "${remote}"?`,
            'Delete'
        );
        if (!ok) { return; }
        // If the branch is already gone on the remote, offer to prune the stale tracking ref.
        // The prune dialog must be shown outside withProgress to avoid overlapping UI.
        let alreadyGone = false;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Deleting remote branch ${branch}...` },
            async () => {
                try {
                    await runGit(item.repo, ['push', remote, '--delete', branch]);
                    await triggerRefresh();
                } catch (e: any) {
                    const msg = String(e.stderr ?? e.message ?? e);
                    if (msg.includes('remote ref does not exist')) {
                        alreadyGone = true;
                    } else {
                        vscode.window.showErrorMessage(msg.trim());
                    }
                }
            }
        );
        if (alreadyGone) {
            const action = await vscode.window.showWarningMessage(
                `"${branch}" no longer exists on "${remote}". Prune stale local tracking ref?`,
                'Prune', 'Cancel'
            );
            if (action === 'Prune') {
                await withProgress(`Pruning ${remote}...`, () =>
                    runGit(item.repo, ['fetch', remote, '--prune'])
                );
            }
        }
    });

    // ---- Cherry-pick ----

    reg('gitBranches.cherryPick', async (item?) => {
        if (!item) { return; }
        const commit = item.ref.commit;
        if (!commit) {
            vscode.window.showErrorMessage('No commit hash available for this ref.');
            return;
        }
        const label = item.ref.name ?? commit.substring(0, 8);
        const ok = await confirm(`Cherry-pick tip commit of "${label}" (${commit.substring(0, 8)}) into current branch?`, 'Cherry-pick');
        if (!ok) { return; }
        await withProgress(`Cherry-picking ${commit.substring(0, 8)}...`, () =>
            runGit(item.repo, ['cherry-pick', commit])
        );
    });
}
