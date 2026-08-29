import * as vscode from 'vscode';
import en from './en';
import zh from './zh';

type Dict = Record<string, string>;

const dicts: Record<'en' | 'zh', Dict> = { en: en as Dict, zh: zh as Dict };

export type Lang = keyof typeof dicts;

// Any zh* (zh, zh-cn, zh-tw, ...) maps to the simplified dict; everything else
// (and unknown) falls back to English. Matches the user's "simplified only" rule.
export function resolveLang(l: string | undefined): Lang {
    return (l ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function getDict(lang: Lang): Dict {
    return dicts[lang];
}

// Host-side (Node) localization used when building static webview HTML inside
// the extension process. Interpolates {0}, {1}, ... positional args.
export function t(key: string, ...args: (string | number)[]): string {
    return makeT(resolveLang(vscode.env.language))(key, ...args);
}

// `t` pinned to a specific language, for builders that receive `lang` as a
// parameter instead of reading vscode.env.language themselves.
export function makeT(lang: Lang): (key: string, ...args: (string | number)[]) => string {
    const dict: Dict = dicts[lang];
    return (key, ...args) => {
        let s = dict[key] ?? dicts.en[key] ?? key;
        args.forEach((a, i) => { s = s.replace(new RegExp(`\\{${i}\\}`, 'g'), String(a)); });
        return s;
    };
}
