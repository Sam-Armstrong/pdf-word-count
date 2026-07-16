import * as vscode from 'vscode';
import * as path from 'path';

type PdfParseFn = (data: Buffer) => Promise<{ text: string }>;

const IGNORE_REFERENCES_KEY = 'pdfWordCount.ignoreReferences';
const REFERENCE_SECTION_PATTERN =
    /(?:^|\n)\s*(?:references|bibliography|works cited|literature cited|citations)\s*(?:\n|$)/i;

/**
 * Counts the number of whitespace-delimited words in a string.
 */
function countWords(text: string): number {
    return text.split(/\s+/).filter((word: string) => word.length > 0).length;
}

/**
 * Removes the references section from extracted PDF text, if one is found.
 */
function stripReferences(text: string): string {
    const match = text.search(REFERENCE_SECTION_PATTERN);
    if (match === -1) {
        return text;
    }
    return text.slice(0, match);
}

/**
 * Builds a cache key for a PDF URI and reference-counting mode.
 */
function getCacheKey(uri: vscode.Uri, ignoreReferences: boolean): string {
    return `${uri.toString()}|ignoreRefs=${ignoreReferences}`;
}

/**
 * Reads a PDF file and returns its extracted text content.
 */
async function extractPdfText(fileUri: vscode.Uri): Promise<string> {
    const pdf = require('pdf-parse') as PdfParseFn;
    const fileData = await vscode.workspace.fs.readFile(fileUri);
    const pdfData = await pdf(Buffer.from(fileData));
    return pdfData.text || '';
}

/**
 * Parses a PDF and returns its word count, optionally excluding references.
 */
async function countWordsInPdf(fileUri: vscode.Uri, ignoreReferences: boolean): Promise<number> {
    let text = await extractPdfText(fileUri);
    if (ignoreReferences) {
        text = stripReferences(text);
    }
    return countWords(text);
}

/**
 * Returns the file URI represented by a tab, when available.
 */
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

    if (typeof input === 'object' && input !== null && 'uri' in input) {
        const uri = (input as { uri?: vscode.Uri }).uri;
        if (uri && typeof uri.fsPath === 'string') {
            return uri;
        }
    }

    return undefined;
}

/**
 * Returns whether a URI points to a PDF file.
 */
function isPdfUri(uri: vscode.Uri): boolean {
    return uri.fsPath.toLowerCase().endsWith('.pdf');
}

/**
 * Extracts a PDF filename from a tab label, if present.
 */
function getPdfFileNameFromTabLabel(label: string): string | undefined {
    const match = label.match(/([^\\/:*?"<>|]+\.pdf)\b/i);
    return match?.[1];
}

/**
 * Resolves a PDF URI from a tab label using workspace paths and search.
 */
async function resolvePdfUriFromTabLabel(label: string): Promise<vscode.Uri | undefined> {
    const fileName = getPdfFileNameFromTabLabel(label);
    if (!fileName) {
        return undefined;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders?.length === 1) {
        const candidate = vscode.Uri.joinPath(workspaceFolders[0].uri, fileName);
        try {
            await vscode.workspace.fs.stat(candidate);
            return candidate;
        } catch {
            // Fall through to workspace search.
        }
    }

    const matches = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 2);
    if (matches.length === 1) {
        return matches[0];
    }

    return undefined;
}

/**
 * Returns the PDF URI for a tab from its input or label.
 */
async function getPdfUriFromTab(tab: vscode.Tab): Promise<vscode.Uri | undefined> {
    const uri = getTabUri(tab);
    if (uri && isPdfUri(uri)) {
        return uri;
    }

    return resolvePdfUriFromTabLabel(tab.label);
}

/**
 * Returns the URI of the PDF that should currently drive the status bar.
 */
async function getActivePdfUri(): Promise<vscode.Uri | undefined> {
    for (const group of vscode.window.tabGroups.all) {
        const candidateTabs = [
            group.activeTab,
            ...group.tabs.filter((tab) => tab.isActive)
        ].filter((tab): tab is vscode.Tab => tab !== undefined);

        for (const tab of candidateTabs) {
            const uri = await getPdfUriFromTab(tab);
            if (uri) {
                return uri;
            }
        }
    }

    const pdfUris: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const uri = await getPdfUriFromTab(tab);
            if (uri) {
                pdfUris.push(uri);
            }
        }
    }

    if (pdfUris.length === 1) {
        return pdfUris[0];
    }

    const editor = vscode.window.activeTextEditor;
    if (editor && isPdfUri(editor.document.uri)) {
        return editor.document.uri;
    }

    return undefined;
}

/**
 * Activates the extension and registers commands, listeners, and the status bar.
 */
export function activate(context: vscode.ExtensionContext) {
    const wordCountCache = new Map<string, number>();
    let updateSequence = 0;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    const startupRetryTimers: ReturnType<typeof setTimeout>[] = [];

    /**
     * Returns whether reference sections should be excluded from word counts.
     */
    function getIgnoreReferences(): boolean {
        return context.globalState.get<boolean>(IGNORE_REFERENCES_KEY, false);
    }

    /**
     * Persists the ignore-references setting across editor sessions.
     */
    async function setIgnoreReferences(value: boolean): Promise<void> {
        await context.globalState.update(IGNORE_REFERENCES_KEY, value);
    }

    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.name = 'PDF Word Count';
    statusBarItem.command = 'pdf-word-count.showOptions';
    context.subscriptions.push(statusBarItem);

    /**
     * Builds the hover tooltip shown for the status bar word count.
     */
    function buildStatusBarTooltip(
        fileName: string,
        wordCount: number,
        ignoreReferences: boolean
    ): vscode.MarkdownString {
        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.isTrusted = true;

        const modeLabel = ignoreReferences ? 'references excluded' : 'references included';
        tooltip.appendMarkdown(`**${fileName}**\n\n`);
        tooltip.appendMarkdown(`${wordCount.toLocaleString()} words (${modeLabel})\n\n`);
        tooltip.appendMarkdown('---\n\n');
        tooltip.appendMarkdown(
            `$(${ignoreReferences ? 'check' : 'circle-outline'}) Ignore references — **${ignoreReferences ? 'On' : 'Off'}**\n\n`
        );
        tooltip.appendMarkdown('Click to toggle reference counting');
        return tooltip;
    }

    /**
     * Updates the status bar text and tooltip for a completed word count.
     */
    function renderStatusBar(
        fileName: string,
        wordCount: number,
        ignoreReferences: boolean
    ): void {
        const refsSuffix = ignoreReferences ? ' · no refs' : '';
        statusBarItem.text = `$(file-pdf) PDF: ${wordCount.toLocaleString()} words${refsSuffix}`;
        statusBarItem.tooltip = buildStatusBarTooltip(fileName, wordCount, ignoreReferences);
    }

    /**
     * Refreshes the status bar for the active PDF, using the cache when possible.
     */
    async function updateStatusBar(): Promise<void> {
        const pdfUri = await getActivePdfUri();
        if (!pdfUri) {
            statusBarItem.hide();
            return;
        }

        const ignoreReferences = getIgnoreReferences();
        const cacheKey = getCacheKey(pdfUri, ignoreReferences);
        const fileName = path.basename(pdfUri.fsPath);
        const sequence = ++updateSequence;

        statusBarItem.text = '$(file-pdf) PDF: Counting...';
        statusBarItem.tooltip = `Counting words in ${fileName}`;
        statusBarItem.show();

        if (wordCountCache.has(cacheKey)) {
            renderStatusBar(fileName, wordCountCache.get(cacheKey)!, ignoreReferences);
            return;
        }

        try {
            const wordCount = await countWordsInPdf(pdfUri, ignoreReferences);
            if (sequence !== updateSequence) {
                return;
            }

            wordCountCache.set(cacheKey, wordCount);
            renderStatusBar(fileName, wordCount, ignoreReferences);
        } catch (err) {
            if (sequence !== updateSequence) {
                return;
            }

            statusBarItem.text = '$(file-pdf) PDF: Count failed';
            statusBarItem.tooltip = `Failed to count words in ${fileName}: ${err}`;
        }
    }

    /**
     * Debounces status bar refreshes to avoid redundant PDF parsing.
     */
    function requestStatusBarUpdate(delay = 0): void {
        if (updateTimer) {
            clearTimeout(updateTimer);
        }

        updateTimer = setTimeout(() => {
            updateTimer = undefined;
            void updateStatusBar();
        }, delay);
    }

    /**
     * Retries status bar updates during startup while tabs and workspace state settle.
     */
    function scheduleInitialStatusBarUpdates(): void {
        for (const delay of [0, 100, 250, 500, 1000, 2000]) {
            const timer = setTimeout(() => {
                requestStatusBarUpdate();
            }, delay);
            startupRetryTimers.push(timer);
        }
    }

    const showOptionsCommand = vscode.commands.registerCommand(
        'pdf-word-count.showOptions',
        async () => {
            const ignoreReferences = getIgnoreReferences();
            type StatusBarOption = vscode.QuickPickItem & { action: 'toggle' | 'recount' };
            const selection = await vscode.window.showQuickPick<StatusBarOption>(
                [
                    {
                        label: `$(${ignoreReferences ? 'check' : 'circle-outline'}) Ignore references`,
                        description: ignoreReferences ? 'Currently on' : 'Currently off',
                        detail: 'Exclude the references/bibliography section from the word count',
                        picked: ignoreReferences,
                        action: 'toggle'
                    },
                    {
                        label: '$(refresh) Recount words',
                        description: 'Refresh the word count for the active PDF',
                        action: 'recount'
                    }
                ],
                {
                    title: 'PDF Word Count Options',
                    placeHolder: 'Choose a counting option'
                }
            );

            if (!selection) {
                return;
            }

            if (selection.action === 'toggle') {
                const nextValue = !ignoreReferences;
                await setIgnoreReferences(nextValue);
                wordCountCache.clear();
                await updateStatusBar();
                return;
            }

            if (selection.action === 'recount') {
                wordCountCache.clear();
                await updateStatusBar();
            }
        }
    );

    const toggleIgnoreReferencesCommand = vscode.commands.registerCommand(
        'pdf-word-count.toggleIgnoreReferences',
        async () => {
            await setIgnoreReferences(!getIgnoreReferences());
            wordCountCache.clear();
            await updateStatusBar();
        }
    );

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

                const ignoreReferences = getIgnoreReferences();
                const wordCount = await countWordsInPdf(fileUri, ignoreReferences);
                wordCountCache.set(getCacheKey(fileUri, ignoreReferences), wordCount);

                const fileName = path.basename(fileUri.fsPath);
                const modeLabel = ignoreReferences ? 'excluding references' : 'including references';
                vscode.window.showInformationMessage(
                    `"${fileName}" contains ${wordCount.toLocaleString()} words (${modeLabel}).`
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
    pdfWatcher.onDidChange((uri) => {
        for (const key of wordCountCache.keys()) {
            if (key.startsWith(uri.toString())) {
                wordCountCache.delete(key);
            }
        }
    });
    pdfWatcher.onDidDelete((uri) => {
        for (const key of wordCountCache.keys()) {
            if (key.startsWith(uri.toString())) {
                wordCountCache.delete(key);
            }
        }
    });

    context.subscriptions.push(
        showOptionsCommand,
        toggleIgnoreReferencesCommand,
        countWordsCommand,
        pdfWatcher,
        vscode.window.onDidChangeActiveTextEditor(() => {
            requestStatusBarUpdate();
        }),
        vscode.window.onDidChangeVisibleTextEditors(() => {
            requestStatusBarUpdate();
        }),
        vscode.window.onDidChangeWindowState(() => {
            requestStatusBarUpdate();
        }),
        vscode.window.tabGroups.onDidChangeTabs(() => {
            requestStatusBarUpdate();
        }),
        vscode.window.tabGroups.onDidChangeTabGroups(() => {
            requestStatusBarUpdate();
        }),
        {
            dispose: () => {
                if (updateTimer) {
                    clearTimeout(updateTimer);
                }
                for (const timer of startupRetryTimers) {
                    clearTimeout(timer);
                }
            }
        }
    );

    scheduleInitialStatusBarUpdates();
}

/**
 * Deactivates the extension.
 */
export function deactivate() {}
