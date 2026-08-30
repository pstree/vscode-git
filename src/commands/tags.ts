// Tag commands (checkout / push / delete / create).

import * as vscode from 'vscode';
import { Repository } from '../gitApi';
import type { RegisterCtx } from './context';
import { confirm, pickRepoOrSingle, withProgress } from '../shared/ui';
import { runGit } from '../git/gitClient';

async function pickRef(repo: Repository): Promise<string | undefined> {
    const headName = repo.state.HEAD?.name;
    const refs: string[] = [
        ...(headName ? [`HEAD (${headName})`] : []),
        ...repo.state.refs.map(r => r.name).filter((n): n is string => !!n),
    ];
    const picks = refs.map(r => ({ label: r, name: r.split(' ')[0] }));
    const picked = await vscode.window.showQuickPick(picks, { placeHolder: 'Select base ref' });
    return picked?.name;
}

export function registerTags(ctx: RegisterCtx): void {
    const { gitApi, reg } = ctx;

    reg('gitBranches.checkoutTag', async (item?) => {
        if (!item) { return; }
        await withProgress(`Checking out tag ${item.ref.name}...`, () =>
            item.repo.checkout(item.ref.name!)
        );
    });

    reg('gitBranches.checkoutTagToBranch', async (item?) => {
        if (!item) { return; }
        const tagName = item.ref.name!;
        const branchName = await vscode.window.showInputBox({
            prompt: `Create and checkout a local branch from tag "${tagName}"`,
            value: tagName,
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!branchName) { return; }
        await withProgress(`Checking out tag ${tagName} as branch ${branchName.trim()}...`, () =>
            item.repo.createBranch(branchName.trim(), true, tagName)
        );
    });

    reg('gitBranches.pushTag', async (item?) => {
        if (!item) { return; }
        const remotes = item.repo.state.remotes;
        if (remotes.length === 0) {
            vscode.window.showErrorMessage('No remotes configured.');
            return;
        }
        let remoteName: string;
        if (remotes.length === 1) {
            remoteName = remotes[0].name;
        } else {
            const picked = await vscode.window.showQuickPick(
                remotes.map(r => ({ label: r.name, description: r.pushUrl ?? r.fetchUrl })),
                { placeHolder: 'Select remote to push tag to' }
            );
            if (!picked) { return; }
            remoteName = picked.label;
        }
        await withProgress(`Pushing tag ${item.ref.name} to ${remoteName}...`, () =>
            runGit(item.repo, ['push', remoteName, `refs/tags/${item.ref.name}`])
        );
    });

    reg('gitBranches.deleteTag', async (item?) => {
        if (!item) { return; }
        const ok = await confirm(`Delete local tag "${item.ref.name}"?`, 'Delete');
        if (!ok) { return; }
        await withProgress(`Deleting tag ${item.ref.name}...`, () =>
            runGit(item.repo, ['tag', '-d', item.ref.name!])
        );
    });

    reg('gitBranches.createTag', async () => {
        const repo = await pickRepoOrSingle(gitApi.repositories);
        if (!repo) { return; }

        const name = await vscode.window.showInputBox({
            prompt: 'Tag name',
            validateInput: v => v.trim() ? undefined : 'Tag name cannot be empty',
        });
        if (!name) { return; }

        const message = await vscode.window.showInputBox({
            prompt: 'Tag message (leave empty for lightweight tag)',
        });
        if (message === undefined) { return; }

        const tagArgs = message.trim()
            ? ['tag', '-a', name.trim(), '-m', message.trim()]
            : ['tag', name.trim()];
        await withProgress(`Creating tag ${name}...`, () =>
            runGit(repo, tagArgs)
        );
    });
}
