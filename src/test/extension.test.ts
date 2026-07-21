import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    deactivate,
    formatFileSize,
    getPdfFileNameFromTabLabel,
    getTabUri,
    isPdfUri,
    resolvePdfUriFromTabLabel,
    wordsPerPage
} from "../extension";
import { getPdfStatsFromBuffer, type PdfStats } from "../pdfText";


function getExtension() {
    return vscode.extensions.all.find(
        (extension) => extension.packageJSON.name === "pdf-word-count"
    );
}

function pdfFixturePath(fileName: string): string {
    return path.join(__dirname, "../../pdfs", fileName);
}

function isPdfStats(value: unknown): value is PdfStats {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const stats = value as PdfStats;
    return (
        typeof stats.wordCount === "number" &&
        typeof stats.charCount === "number" &&
        typeof stats.charCountExcludingSpaces === "number" &&
        typeof stats.pageCount === "number"
    );
}

/**
 * Captures window messages so tests can assert success/failure rather than
 * only checking that swallowed errors did not reject the command promise.
 */
function captureWindowMessages(): {
    info: string[];
    errors: string[];
    dispose: () => void;
} {
    const info: string[] = [];
    const errors: string[] = [];
    const originalInfo = vscode.window.showInformationMessage;
    const originalError = vscode.window.showErrorMessage;

    (vscode.window as { showInformationMessage: typeof originalInfo }).showInformationMessage =
        ((message: string, ..._rest: unknown[]) => {
            info.push(message);
            return Promise.resolve(undefined);
        }) as typeof originalInfo;

    (vscode.window as { showErrorMessage: typeof originalError }).showErrorMessage =
        ((message: string, ..._rest: unknown[]) => {
            errors.push(message);
            return Promise.resolve(undefined);
        }) as typeof originalError;

    return {
        info,
        errors,
        dispose: () => {
            vscode.window.showInformationMessage = originalInfo;
            vscode.window.showErrorMessage = originalError;
        }
    };
}

suite("extension helpers", () => {
    test("formatFileSize uses compact byte units", () => {
        assert.strictEqual(formatFileSize(0), "0 B");
        assert.strictEqual(formatFileSize(512), "512 B");
        assert.strictEqual(formatFileSize(1536), "1.5 KB");
        assert.strictEqual(formatFileSize(10 * 1024), "10 KB");
        assert.strictEqual(formatFileSize(1.5 * 1024 * 1024), "1.5 MB");
        assert.strictEqual(formatFileSize(12 * 1024 * 1024), "12 MB");
    });

    test("wordsPerPage rounds to the nearest integer", () => {
        assert.strictEqual(wordsPerPage({ wordCount: 1000, pageCount: 3 }), 333);
        assert.strictEqual(wordsPerPage({ wordCount: 1000, pageCount: 4 }), 250);
        assert.strictEqual(wordsPerPage({ wordCount: 10, pageCount: 0 }), 0);
    });

    test("getPdfFileNameFromTabLabel extracts pdf filenames from tab labels", () => {
        assert.strictEqual(getPdfFileNameFromTabLabel("adam.pdf"), "adam.pdf");
        assert.strictEqual(
            getPdfFileNameFromTabLabel("adam.pdf - PDF Word Count"),
            "adam.pdf"
        );
        assert.strictEqual(
            getPdfFileNameFromTabLabel("reports\\interim_report.pdf"),
            "interim_report.pdf"
        );
        assert.strictEqual(getPdfFileNameFromTabLabel("README.md"), undefined);
        assert.strictEqual(getPdfFileNameFromTabLabel(""), undefined);
    });

    test("isPdfUri matches pdf paths case-insensitively", () => {
        assert.strictEqual(isPdfUri(vscode.Uri.file("/tmp/report.pdf")), true);
        assert.strictEqual(isPdfUri(vscode.Uri.file("/tmp/report.PDF")), true);
        assert.strictEqual(isPdfUri(vscode.Uri.file("/tmp/report.txt")), false);
        assert.strictEqual(isPdfUri(vscode.Uri.file("/tmp/pdf")), false);
    });

    test("getTabUri reads URIs from supported tab input types", () => {
        const pdfUri = vscode.Uri.file("/tmp/example.pdf");
        const textUri = vscode.Uri.file("/tmp/example.txt");
        const originalUri = vscode.Uri.file("/tmp/original.txt");
        const modifiedUri = vscode.Uri.file("/tmp/modified.txt");

        assert.strictEqual(
            getTabUri({ input: new vscode.TabInputText(pdfUri) } as vscode.Tab)?.fsPath,
            pdfUri.fsPath
        );
        assert.strictEqual(
            getTabUri({ input: new vscode.TabInputCustom(pdfUri, "pdf.preview") } as vscode.Tab)?.fsPath,
            pdfUri.fsPath
        );
        assert.strictEqual(
            getTabUri({
                input: new vscode.TabInputTextDiff(originalUri, modifiedUri)
            } as vscode.Tab)?.fsPath,
            modifiedUri.fsPath
        );
        assert.strictEqual(
            getTabUri({ input: { uri: textUri } } as vscode.Tab)?.fsPath,
            textUri.fsPath
        );
        assert.strictEqual(getTabUri({ input: undefined } as vscode.Tab), undefined);
    });

    test("resolvePdfUriFromTabLabel finds workspace PDFs by filename", async function () {
        const adamPath = pdfFixturePath("adam.pdf");
        if (!fs.existsSync(adamPath)) {
            this.skip();
            return;
        }

        const resolved = await resolvePdfUriFromTabLabel("adam.pdf");
        assert.ok(resolved);
        assert.strictEqual(path.basename(resolved!.fsPath), "adam.pdf");
    });

    test("resolvePdfUriFromTabLabel returns undefined when no pdf is named in the label", async () => {
        const resolved = await resolvePdfUriFromTabLabel("README.md");
        assert.strictEqual(resolved, undefined);
    });
});

suite("extension integration", function () {
    this.timeout(60000);

    test("loads and activates the extension on startup", () => {
        const extension = getExtension();
        assert.ok(extension, "expected pdf-word-count extension to be present");
        assert.ok(extension!.isActive, "expected extension to activate on startup");
    });

    test("registers pdf word count commands", async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes("pdf-word-count.countWords"));
        assert.ok(commands.includes("pdf-word-count.recount"));
    });

    test("countWords parses a provided PDF URI via the bundled extension", async function () {
        // This executes dist/extension.js in the extension host — not out/pdfText.js —
        // so a swallowed ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING would fail the return assert.
        const adamPath = pdfFixturePath("adam.pdf");
        if (!fs.existsSync(adamPath)) {
            this.skip();
            return;
        }

        const uri = vscode.Uri.file(adamPath);
        const expectedStats = await getPdfStatsFromBuffer(
            new Uint8Array(fs.readFileSync(adamPath))
        );
        const messages = captureWindowMessages();

        try {
            const stats = await vscode.commands.executeCommand<PdfStats | undefined>(
                "pdf-word-count.countWords",
                uri
            );

            assert.ok(isPdfStats(stats), "expected countWords to return PDF stats on success");
            assert.ok(stats!.wordCount > 1000);
            assert.strictEqual(stats!.wordCount, expectedStats.wordCount);
            assert.strictEqual(stats!.pageCount, expectedStats.pageCount);
            assert.ok(stats!.pageCount > 0);
            assert.ok(
                messages.info.some((message) => message.includes("contains") && message.includes("words")),
                `expected a success info message, got: ${JSON.stringify(messages.info)}`
            );
            assert.deepStrictEqual(
                messages.errors,
                [],
                `expected no error messages, got: ${JSON.stringify(messages.errors)}`
            );
        } finally {
            messages.dispose();
        }
    });

    test("countWords reports an error for unreadable PDFs", async () => {
        const missingUri = vscode.Uri.file(path.join(__dirname, "../../pdfs/does-not-exist.pdf"));
        const messages = captureWindowMessages();

        try {
            const stats = await vscode.commands.executeCommand<PdfStats | undefined>(
                "pdf-word-count.countWords",
                missingUri
            );

            assert.strictEqual(stats, undefined);
            assert.ok(
                messages.errors.some((message) => message.includes("Failed to parse PDF")),
                `expected a parse error message, got: ${JSON.stringify(messages.errors)}`
            );
        } finally {
            messages.dispose();
        }
    });

    test("recount returns stats for an open PDF through the status bar path", async function () {
        const adamPath = pdfFixturePath("adam.pdf");
        if (!fs.existsSync(adamPath)) {
            this.skip();
            return;
        }

        const uri = vscode.Uri.file(adamPath);
        await vscode.commands.executeCommand("vscode.open", uri);

        // allow tab / custom editor state to settle before resolving the active PDF
        await new Promise((resolve) => setTimeout(resolve, 500));

        const stats = await vscode.commands.executeCommand<PdfStats | undefined>(
            "pdf-word-count.recount"
        );

        assert.ok(
            isPdfStats(stats),
            "expected recount to return stats for the active PDF (status bar path)"
        );
        assert.ok(stats!.wordCount > 1000);
        assert.ok(stats!.charCount > stats!.charCountExcludingSpaces);
        assert.ok(stats!.pageCount > 0);
        assert.ok(
            typeof (stats as PdfStats & { fileSizeBytes?: number }).fileSizeBytes === "number"
        );
    });

    test("recount returns undefined when no PDF is active", async () => {
        // close editors so getActivePdfUri has nothing to bind to
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");

        const stats = await vscode.commands.executeCommand<PdfStats | undefined>(
            "pdf-word-count.recount"
        );
        assert.strictEqual(stats, undefined);
    });

    test("deactivate is safe to call", () => {
        assert.doesNotThrow(() => deactivate());
    });
});
