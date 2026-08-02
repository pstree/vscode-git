import * as vscode from 'vscode';
import { getGitApi } from './gitApi';
import { BranchesProvider, HiddenRepos, TagProvider } from './branchTreeProvider';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
    const gitApi = getGitApi();
    if (!gitApi) {
        vscode.window.showErrorMessage(
            'Git Branches: Could not access the built-in git extension. Ensure git is installed and the git extension is enabled.'
        );
        return;
    }

    const hiddenRepos = new HiddenRepos(context.workspaceState);
    const branchesProvider = new BranchesProvider(gitApi, hiddenRepos);
    const tagProvider = new TagProvider(gitApi, hiddenRepos);

    const branchesView = vscode.window.createTreeView('gitBranches.branches', {
        treeDataProvider: branchesProvider,
        showCollapseAll: false,
    });
    const tagView = vscode.window.createTreeView('gitBranches.tags', {
        treeDataProvider: tagProvider,
        showCollapseAll: false,
    });

    const refresh = async () => {
        // The built-in git extension watches each repository and fires
        // state.onDidChange on ref/HEAD/index changes; give it a moment to
        // propagate before we re-query. We deliberately do NOT call the global
        // `git.refresh` here — in a multi-repo workspace it pops a
        // "Select repository" QuickPick, which breaks every git op that goes
        // through withProgress (pull/push/fetch/reset/...).
        await new Promise(r => setTimeout(r, 500));
        branchesProvider.invalidate();
        tagProvider.invalidate();
    };

    registerCommands(context, gitApi, refresh, hiddenRepos, branchesProvider);

    context.subscriptions.push(
        branchesView,
        tagView,
        branchesProvider,
        tagProvider,
    );
}

export function deactivate(): void {}
