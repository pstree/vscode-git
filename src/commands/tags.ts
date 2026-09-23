// Tag commands (checkout / push / delete / create).

import * as vscode from 'vscode';
import { Repository } from '../gitApi';
import type { RegisterCtx } from './context';
import { pickRepoOrSingle, withProgress } from '../shared/ui';
import { execFileAsync, getGitPath, listRemoteTags, runGit } from '../git/gitClient';

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

/**
 * Remote a tag operation talks to: the lone remote, or a QuickPick when several
 * are configured. `required` decides whether "no remotes" is an error (push) or
 * merely means there is nothing remote to touch (delete → local only).
 */
async function pickRemote(repo: Repository, placeHolder: string, required = true): Promise<string | undefined> {
    const remotes = repo.state.remotes;
    if (remotes.length === 0) {
        if (required) { vscode.window.showErrorMessage('No remotes configured.'); }
        return undefined;
    }
    if (remotes.length === 1) { return remotes[0].name; }
    const picked = await vscode.window.showQuickPick(
        remotes.map(r => ({ label: r.name, description: r.pushUrl ?? r.fetchUrl })),
        { placeHolder }
    );
    return picked?.label;
}

/**
 * Local commit a tag points at, or undefined when there is no such tag.
 * `^{commit}` peels annotated tags so the value is comparable with the remote
 * map; `--quiet` keeps a miss silent (exit 1, no output).
 */
async function localTagCommit(repo: Repository, tagName: string): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync(
            getGitPath(),
            ['rev-parse', '--verify', '--quiet', `refs/tags/${tagName}^{commit}`],
            { cwd: repo.rootUri.fsPath }
        );
        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
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
        const tagName = item?.ref.name;
        if (!item || !tagName) { return; }
        const remoteName = await pickRemote(item.repo, 'Select remote to push tag to');
        if (!remoteName) { return; }

        // Compare commits up front rather than parsing git's output: the push is
        // rejected exactly when the remote already has this tag at another commit,
        // and git localizes that error message.
        const [localCommit, remoteTags] = await Promise.all([
            localTagCommit(item.repo, tagName),
            listRemoteTags(item.repo, remoteName),
        ]);
        const remoteCommit = remoteTags?.get(tagName);
        if (remoteCommit && localCommit && remoteCommit !== localCommit) {
            const overwrite = await vscode.window.showWarningMessage(
                `Remote tag "${tagName}" exists on ${remoteName} at a different commit. Overwrite it?`,
                { modal: true }, 'Force Push'
            );
            if (overwrite !== 'Force Push') { return; }
            await withProgress(`Force pushing tag ${tagName} to ${remoteName}...`, () =>
                runGit(item.repo, ['push', '--force', remoteName, `refs/tags/${tagName}`])
            );
            return;
        }

        await withProgress(`Pushing tag ${tagName} to ${remoteName}...`, () =>
            runGit(item.repo, ['push', remoteName, `refs/tags/${tagName}`])
        );
    });

    reg('gitBranches.deleteTag', async (item?) => {
        const tagName = item?.ref.name;
        if (!item || !tagName) { return; }

        // Deleting only the local tag leaves the remote one behind, which reads as
        // "delete did nothing" — offer both scopes when the tag exists remotely.
        const remoteName = await pickRemote(item.repo, 'Select remote to check for the tag', false);
        const remoteTags = remoteName ? await listRemoteTags(item.repo, remoteName) : undefined;
        const onRemote = remoteTags?.has(tagName) ?? false;
        const deleteBothLabel = 'Delete local + remote';
        const picked = onRemote
            ? await vscode.window.showWarningMessage(
                `Tag "${tagName}" also exists on ${remoteName}. What should be deleted?`,
                { modal: true }, 'Delete local only', deleteBothLabel)
            : await vscode.window.showWarningMessage(
                `Delete local tag "${tagName}"?`, { modal: true }, 'Delete');
        if (!picked) { return; }

        await withProgress(`Deleting tag ${tagName}...`, async () => {
            // Remote ref first: if that fails (offline / no permission) the local
            // tag stays intact instead of being half-deleted.
            if (picked === deleteBothLabel && remoteName) {
                await runGit(item.repo, ['push', remoteName, `:refs/tags/${tagName}`]);
            }
            await runGit(item.repo, ['tag', '-d', tagName]);
        });
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

        const tagName = name.trim();
        const tagArgs = message.trim()
            ? ['tag', '-a', tagName, '-m', message.trim()]
            : ['tag', tagName];
        // A tag name is repo-global and git refuses to move an existing tag, so ask
        // about overwriting up front — checking the ref instead of matching git's
        // (localized) "already exists" message.
        const exists = (await localTagCommit(repo, tagName)) !== undefined;
        if (exists) {
            const overwrite = await vscode.window.showWarningMessage(
                `Tag "${tagName}" already exists. Overwrite it?`,
                { modal: true }, 'Overwrite'
            );
            if (overwrite !== 'Overwrite') { return; }
        }
        const args = exists ? ['tag', '-f', ...tagArgs.slice(1)] : tagArgs;
        await withProgress(`${exists ? 'Overwriting' : 'Creating'} tag ${tagName}...`, () =>
            runGit(repo, args)
        );
    });
}
