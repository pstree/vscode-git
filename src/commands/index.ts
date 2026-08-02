// Command registration hub.
//
// `registerCommands` composes every command group and wires the
// `gitBranches.*` IDs to their handlers. Each group lives in its own module
// under `commands/`; this file just instantiates the shared registration helper
// and delegates to the group registrars. It also registers the history
// WebviewViewProvider and the commit-file virtual document provider.

import * as vscode from 'vscode';
import type { BranchItem, BranchesProvider, HiddenRepos } from '../branchTreeProvider';
import { GitApi } from '../gitApi';
import { CommitFileContentProvider, COMMIT_FILE_SCHEME } from '../history/commitFileProvider';
import { setRefresh } from '../shared/ui';
import { registerBranches } from './branches';
import { registerTags } from './tags';
import { registerGlobal } from './global';
import { HistoryViewProvider, HISTORY_VIEW_TYPE, registerHistoryView } from '../history/historyView';

export function registerCommands(
    context: vscode.ExtensionContext,
    gitApi: GitApi,
    refresh: () => Promise<void>,
    hiddenRepos: HiddenRepos,
    branchesProvider: BranchesProvider,
): void {
    setRefresh(refresh);

    const reg: (id: string, fn: (item?: BranchItem) => Promise<void>) => void =
        (id, fn) => { context.subscriptions.push(vscode.commands.registerCommand(id, fn)); };

    // Virtual document provider for viewing commit-file contents.
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            COMMIT_FILE_SCHEME,
            new CommitFileContentProvider()
        )
    );

    // Create the docked Git History WebviewView provider once and share the
    // instance with the branch commands so a branch pull can re-scope it.
    const historyView = new HistoryViewProvider(context, gitApi);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(HISTORY_VIEW_TYPE, historyView, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    registerBranches({ context, gitApi, hiddenRepos, branchesProvider, historyView, reg });
    registerTags({ context, gitApi, hiddenRepos, reg });
    registerGlobal({ context, gitApi, hiddenRepos, branchesProvider, reg });
    registerHistoryView(context, historyView, gitApi);
}
