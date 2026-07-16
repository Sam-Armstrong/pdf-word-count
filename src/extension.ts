import * as vscode from 'vscode';
import * as path from 'path';

type PdfParseFn = (data: Buffer) => Promise<{ text: string }>;

async function countWordsInPdf(fileUri: vscode.Uri): Promise<number> {
    const pdf = require('pdf-parse') as PdfParseFn;
    const fileData = await vscode.workspace.fs.readFile(fileUri);
    const pdfData = await pdf(Buffer.from(fileData));
    const text = pdfData.text || '';
    return text.split(/\s+/).filter((word: string) => word.length > 0).length;
}

function getTabUri(tab: vscode.Tab): vscode.Uri | undefined {
    const input = tab.input;

    if (input instanceof vscode.TabInputText) {
        return input.uri;
    }
    if (input instanceof vscode.TabInputCustom) {
        return input.uri;
    }
    if (input instanceof vscode.TabInputTextDiff) {
        return input.modified;
    }

    // Duck-type uri for custom viewers that don't use standard tab input classes.
    if (typeof input === 'object' && input !== null && 'uri' in input) {
        const uri = (input as { uri?: vscode.Uri }).uri;
        if (uri && typeof uri.fsPath === 'string') {
            return uri;
        }
    }

    return undefined;
}

function isPdfUri(uri: vscode.Uri): boolean {
    return uri.fsPath.toLowerCase().endsWith('.pdf');
}

function getPdfFileNameFromTabLabel(label: string): string | undefined {
    const match = label.match(/([^\\/:*?"<>|]+\.pdf)\b/i);
    return match?.[1];
}

async function resolvePdfUriFromTabLabel(label: string): Promise<vscode.Uri | undefined> {
    const fileName = getPdfFileNameFromTabLabel(label);
    if (!fileName) {
        return undefined;
    }

    const matches = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 2);
    if (matches.length === 1) {
        return matches[0];
    }

    return undefined;
}

async function getActivePdfUri(): Promise<vscode.Uri | undefined> {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (activeTab) {
        const uri = getTabUri(activeTab);
        if (uri && isPdfUri(uri)) {
            return uri;
        }

        const labelUri = await resolvePdfUriFromTabLabel(activeTab.label);
        if (labelUri) {
            return labelUri;
        }
    }

    const editor = vscode.window.activeTextEditor;
    if (editor && isPdfUri(editor.document.uri)) {
        return editor.document.uri;
    }

    return undefined;
}

export function activate(context: vscode.ExtensionContext) {
    const wordCountCache = new Map<string, number>();
    let updateSequence = 0;

    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.name = 'PDF Word Count';
    statusBarItem.command = 'pdf-word-count.countWords';
    context.subscriptions.push(statusBarItem);

    async function updateStatusBar(): Promise<void> {
        const pdfUri = await getActivePdfUri();
        if (!pdfUri) {
            statusBarItem.hide();
            return;
        }

        const cacheKey = pdfUri.toString();
        const fileName = path.basename(pdfUri.fsPath);
        const sequence = ++updateSequence;

        statusBarItem.text = '$(file-pdf) PDF: Counting...';
        statusBarItem.tooltip = `Counting words in ${fileName}`;
        statusBarItem.show();

        if (wordCountCache.has(cacheKey)) {
            const wordCount = wordCountCache.get(cacheKey)!;
            statusBarItem.text = `$(file-pdf) PDF: ${wordCount.toLocaleString()} words`;
            statusBarItem.tooltip = `${fileName} — ${wordCount.toLocaleString()} words`;
            return;
        }

        try {
            const wordCount = await countWordsInPdf(pdfUri);
            if (sequence !== updateSequence) {
                return;
            }

            wordCountCache.set(cacheKey, wordCount);
            statusBarItem.text = `$(file-pdf) PDF: ${wordCount.toLocaleString()} words`;
            statusBarItem.tooltip = `${fileName} — ${wordCount.toLocaleString()} words`;
        } catch (err) {
            if (sequence !== updateSequence) {
                return;
            }

            statusBarItem.text = '$(file-pdf) PDF: Count failed';
            statusBarItem.tooltip = `Failed to count words in ${fileName}: ${err}`;
        }
    }

    const countWordsCommand = vscode.commands.registerCommand(
        'pdf-word-count.countWords',
        async (uri?: vscode.Uri) => {
            let fileUri = uri ?? await getActivePdfUri();

            if (!fileUri) {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'PDF Documents': ['pdf'] }
                });
                if (uris && uris.length > 0) {
                    fileUri = uris[0];
                } else {
                    return;
                }
            }

            try {
                vscode.window.showInformationMessage('Parsing PDF...');

                const wordCount = await countWordsInPdf(fileUri);
                wordCountCache.set(fileUri.toString(), wordCount);

                const fileName = path.basename(fileUri.fsPath);
                vscode.window.showInformationMessage(
                    `"${fileName}" contains ${wordCount.toLocaleString()} words.`
                );

                if ((await getActivePdfUri())?.toString() === fileUri.toString()) {
                    await updateStatusBar();
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to parse PDF: ${err}`);
            }
        }
    );

    const pdfWatcher = vscode.workspace.createFileSystemWatcher('**/*.pdf');
    pdfWatcher.onDidChange((uri) => wordCountCache.delete(uri.toString()));
    pdfWatcher.onDidDelete((uri) => wordCountCache.delete(uri.toString()));

    context.subscriptions.push(
        countWordsCommand,
        pdfWatcher,
        vscode.window.onDidChangeActiveTextEditor(() => {
            void updateStatusBar();
        }),
        vscode.window.tabGroups.onDidChangeTabs(() => {
            void updateStatusBar();
        })
    );

    void updateStatusBar();
}

export function deactivate() {}
