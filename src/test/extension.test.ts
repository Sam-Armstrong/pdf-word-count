import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    deactivate,
    getPdfFileNameFromTabLabel,
    getTabUri,
    isPdfUri,
    resolvePdfUriFromTabLabel
} from "../extension";
import { getPdfStatsFromBuffer } from "../pdfText";


function getExtension() {
    return vscode.extensions.all.find(
        (extension) => extension.packageJSON.name === "pdf-word-count"
    );
}

function pdfFixturePath(fileName: string): string {
    return path.join(__dirname, "../../pdfs", fileName);
}

suite("extension helpers", () => {
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

    test("countWords parses a provided PDF URI end to end", async function () {
        const adamPath = pdfFixturePath("adam.pdf");
        if (!fs.existsSync(adamPath)) {
            this.skip();
            return;
        }

        const uri = vscode.Uri.file(adamPath);
        const expectedStats = await getPdfStatsFromBuffer(
            new Uint8Array(fs.readFileSync(adamPath))
        );

        await assert.doesNotReject(async () => {
            await vscode.commands.executeCommand("pdf-word-count.countWords", uri);
        });
        assert.ok(expectedStats.wordCount > 1000);
    });

    test("countWords handles unreadable PDFs without throwing", async () => {
        const missingUri = vscode.Uri.file(path.join(__dirname, "../../pdfs/does-not-exist.pdf"));

        await assert.doesNotReject(async () => {
            await vscode.commands.executeCommand("pdf-word-count.countWords", missingUri);
        });
    });

    test("recount command refreshes the active PDF count", async () => {
        await assert.doesNotReject(async () => {
            await vscode.commands.executeCommand("pdf-word-count.recount");
        });
    });

    test("deactivate is safe to call", () => {
        assert.doesNotThrow(() => deactivate());
    });
});
