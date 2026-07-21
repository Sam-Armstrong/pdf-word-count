import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
    assembleTextFromItems,
    countCharacters,
    countCharactersExcludingSpaces,
    countWords,
    extractPdfTextFromBuffer,
    getPdfStatsFromBuffer,
    getPdfStatsFromText,
    shouldJoinHyphenatedLineBreak,
    type PdfTextItem
} from "../pdfText";

function item(
    str: string,
    x: number,
    y: number,
    width: number,
    height = 10,
    hasEOL = false
): PdfTextItem {
    return {
        str,
        transform: [1, 0, 0, 1, x, y],
        width,
        height,
        hasEOL
    };
}

suite("pdfText position-aware extraction", () => {
    test("inserts a space when horizontal gap indicates a word break", () => {
        const text = assembleTextFromItems([
            item("Hello", 0, 100, 30),
            // gap of 8 with height 10 => above 0.15 threshold
            item("world", 38, 100, 30)
        ]);

        assert.strictEqual(text, "Hello world");
        assert.strictEqual(countWords(text), 2);
    });

    test("does not insert a space for tightly packed glyphs", () => {
        const text = assembleTextFromItems([
            item("Hel", 0, 100, 18),
            item("lo", 18.5, 100, 12)
        ]);

        assert.strictEqual(text, "Hello");
        assert.strictEqual(countWords(text), 1);
    });

    test("joins soft hyphenation across a line break", () => {
        const text = assembleTextFromItems([
            item("ap-", 0, 200, 20, 10, true),
            item("plication", 0, 188, 50)
        ]);

        assert.strictEqual(text, "application");
        assert.strictEqual(countWords(text), 1);
    });

    test("joins soft hyphenation when Y changes without hasEOL", () => {
        const text = assembleTextFromItems([
            item("trans-", 0, 200, 40),
            item("formed", 0, 185, 40)
        ]);

        assert.strictEqual(text, "transformed");
    });

    test("keeps a hard hyphen before a capitalised continuation", () => {
        const text = assembleTextFromItems([
            item("state-", 0, 200, 30, 10, true),
            item("The", 0, 185, 20)
        ]);

        assert.strictEqual(text, "state-\nThe");
        assert.strictEqual(countWords(text), 2);
    });

    test("shouldJoinHyphenatedLineBreak matches Docs/Word-like soft breaks", () => {
        assert.strictEqual(shouldJoinHyphenatedLineBreak("ap-", "plication"), true);
        assert.strictEqual(shouldJoinHyphenatedLineBreak("state-", "The"), false);
        assert.strictEqual(shouldJoinHyphenatedLineBreak("n-", "2"), false);
        assert.strictEqual(shouldJoinHyphenatedLineBreak("hello", "world"), false);
        assert.strictEqual(shouldJoinHyphenatedLineBreak("2-", "nd"), true);
        assert.strictEqual(shouldJoinHyphenatedLineBreak("ap-", "Plication"), false);
        assert.strictEqual(shouldJoinHyphenatedLineBreak("", "word"), false);
        assert.strictEqual(shouldJoinHyphenatedLineBreak("word-", ""), false);
    });

    test("returns empty text for no items", () => {
        assert.strictEqual(assembleTextFromItems([]), "");
        assert.strictEqual(countWords(assembleTextFromItems([])), 0);
    });

    test("filters out empty items without end-of-line markers", () => {
        const text = assembleTextFromItems([
            item("", 0, 100, 0),
            item("hello", 0, 100, 30)
        ]);

        assert.strictEqual(text, "hello");
    });

    test("derives glyph height from transform when height is missing", () => {
        const text = assembleTextFromItems([
            {
                str: "Hi",
                transform: [1, 0, 0, 12, 0, 100],
                width: 20,
                height: 0
            },
            {
                str: "there",
                transform: [1, 0, 0, 12, 30, 100],
                width: 40,
                height: 0
            }
        ]);

        assert.strictEqual(text, "Hi there");
    });

    test("does not add a newline when output already ends with whitespace", () => {
        const text = assembleTextFromItems([
            item("line one ", 0, 200, 60, 10, true),
            item("line two", 0, 185, 50)
        ]);

        assert.strictEqual(text, "line one line two");
    });

    test("does not add a newline for empty continuation after a line break", () => {
        const text = assembleTextFromItems([
            item("line one", 0, 200, 50, 10, true),
            item("", 0, 185, 0, 10, true),
            item("line two", 0, 170, 50)
        ]);

        assert.strictEqual(text, "line one\nline two");
    });

    test("does not insert a space when the next item already starts with whitespace", () => {
        const text = assembleTextFromItems([
            item("Hello", 0, 100, 30),
            item(" world", 40, 100, 30)
        ]);

        assert.strictEqual(text, "Hello world");
    });

    test("does not insert a duplicate space when output already ends with whitespace", () => {
        const text = assembleTextFromItems([
            item("Hello ", 0, 100, 32),
            item("world", 40, 100, 30)
        ]);

        assert.strictEqual(text, "Hello world");
    });

    test("inserts a newline for unrelated line breaks", () => {
        const text = assembleTextFromItems([
            item("first", 0, 200, 30, 10, true),
            item("second", 0, 180, 30)
        ]);

        assert.strictEqual(text, "first\nsecond");
        assert.strictEqual(countWords(text), 2);
    });

    test("getPdfStatsFromText aggregates the counting helpers", () => {
        const text = "Hello, world — …";
        const stats = getPdfStatsFromText(text);

        assert.strictEqual(stats.wordCount, countWords(text));
        assert.strictEqual(stats.charCount, countCharacters(text));
        assert.strictEqual(
            stats.charCountExcludingSpaces,
            countCharactersExcludingSpaces(text)
        );
    });
});

suite("pdfText counting helpers", () => {
    test("countWords skips punctuation-only tokens", () => {
        assert.strictEqual(countWords("Hello, world — …"), 2);
        assert.strictEqual(countWords("— … !!"), 0);
        assert.strictEqual(countWords(""), 0);
        assert.strictEqual(countWords("   \t\n  "), 0);
        assert.strictEqual(countWords("word"), 1);
        assert.strictEqual(countWords("one\ttwo\n\nthree"), 3);
    });

    test("countCharacters includes punctuation and whitespace", () => {
        assert.strictEqual(countCharacters("Hello, world — …"), 16);
        assert.strictEqual(countCharacters("a\nb c"), 5);
        assert.strictEqual(countCharacters(""), 0);
    });

    test("countCharactersExcludingSpaces removes all whitespace", () => {
        assert.strictEqual(countCharactersExcludingSpaces("Hello, world — …"), 13);
        assert.strictEqual(countCharactersExcludingSpaces("a\nb c"), 3);
        assert.strictEqual(countCharactersExcludingSpaces("   "), 0);
    });

    test("getPdfStatsFromText returns zero counts for empty text", () => {
        const stats = getPdfStatsFromText("");
        assert.deepStrictEqual(stats, {
            wordCount: 0,
            charCount: 0,
            charCountExcludingSpaces: 0
        });
    });
});

suite("pdfText extension-host loading", function () {
    this.timeout(60000);

    test("extension bundle does not dynamically import pdfjs-dist at runtime", () => {
        // The VS Code / Cursor extension host runs extension code in a context
        // where import() throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING. pdf.js
        // must therefore be bundled into dist/extension.js (CJS), and its
        // worker must be preloaded onto globalThis.pdfjsWorker so the fake
        // worker path does not call import() either.
        const bundlePath = path.join(__dirname, "../../dist/extension.js");
        assert.ok(fs.existsSync(bundlePath), `missing bundle at ${bundlePath}`);
        const bundle = fs.readFileSync(bundlePath, "utf8");

        assert.equal(
            /import\(\s*["']pdfjs-dist/.test(bundle),
            false,
            "dist/extension.js must not leave pdfjs-dist as a runtime dynamic import"
        );
    });

    test("pdfText loader eagerly imports the pdf.js worker module", () => {
        // Node disables real workers, so pdf.js falls back to a fake worker that
        // does `import(workerSrc)`. Pre-importing the worker populates
        // globalThis.pdfjsWorker and avoids that dynamic import.
        const source = fs.readFileSync(
            path.join(__dirname, "../../src/pdfText.ts"),
            "utf8"
        );
        assert.match(
            source,
            /pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs/,
            "expected getPdfModule to import pdf.worker.mjs for extension-host compatibility"
        );
    });

    test("bundled dist/pdfText.js can parse adam.pdf", async function () {
        // Exercises the same esbuild/CJS + bundled-pdfjs path as the extension.
        // Run in a clean Node process so we do not share globalThis.pdfjsWorker with
        // out/pdfText.js or the already-loaded extension host bundle.
        const adamPath = path.join(__dirname, "../../pdfs/adam.pdf");
        const bundlePath = path.join(__dirname, "../../dist/pdfText.js");
        if (!fs.existsSync(adamPath)) {
            this.skip();
            return;
        }
        assert.ok(fs.existsSync(bundlePath), `missing bundle at ${bundlePath}; run npm run compile`);

        const script = `
            const fs = require("fs");
            const bundled = require(${JSON.stringify(bundlePath)});
            (async () => {
                // Copy out of Node's Buffer pool — Electron's structuredClone cannot
                // transfer Buffer-backed Uint8Array views (DataCloneError).
                const fileBuffer = fs.readFileSync(${JSON.stringify(adamPath)});
                const data = new Uint8Array(fileBuffer.byteLength);
                data.set(fileBuffer);
                const text = await bundled.extractPdfTextFromBuffer(data);
                const stats = await bundled.getPdfStatsFromBuffer(data);
                if (!/\\bAdam\\b/.test(text)) {
                    console.error("missing Adam marker");
                    process.exit(2);
                }
                if (!(stats.wordCount > 1000)) {
                    console.error("low word count", stats);
                    process.exit(3);
                }
                if (typeof globalThis.pdfjsWorker?.WorkerMessageHandler !== "function") {
                    console.error("pdfjsWorker not installed");
                    process.exit(4);
                }
                console.log(JSON.stringify(stats));
            })().catch((err) => {
                console.error(err);
                process.exit(1);
            });
        `;

        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        // vscode-test sets process.execPath to Electron's helper, which is not a
        // general-purpose Node binary for this smoke test.
        const nodeBinary =
            /Code Helper|Electron/i.test(process.execPath) ? "node" : process.execPath;
        const { stdout, stderr } = await execFileAsync(nodeBinary, ["-e", script], {
            maxBuffer: 10 * 1024 * 1024
        });

        assert.ok(
            !/DataCloneError|ERR_VM_DYNAMIC_IMPORT/i.test(stderr),
            `bundled parser failed: ${stderr}`
        );
        const stats = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
            wordCount: number;
        };
        assert.ok(stats.wordCount > 1000);
    });
});

suite("pdfText real PDF integration", function () {
    this.timeout(60000);

    const op2Path = path.join(__dirname, "../../pdfs/OP2.pdf");
    const hasOp2 = fs.existsSync(op2Path);

    (hasOp2 ? test : test.skip)(
        "joins hyphenated line breaks in OP2.pdf",
        async () => {
            const data = new Uint8Array(fs.readFileSync(op2Path));
            const text = await extractPdfTextFromBuffer(data);

            assert.match(text, /single application code/i);
            assert.doesNotMatch(text, /ap-\s*\n\s*plication/i);
            assert.match(text, /transformed into different/i);

            const stats = getPdfStatsFromText(text);
            assert.ok(stats.wordCount > 1000, `expected substantial word count, got ${stats.wordCount}`);
            assert.ok(stats.charCount > stats.charCountExcludingSpaces);
        }
    );

    const adamPath = path.join(__dirname, "../../pdfs/adam.pdf");
    const hasAdam = fs.existsSync(adamPath);

    (hasAdam ? test : test.skip)(
        "extracts spaced abstract text from adam.pdf",
        async () => {
            const data = new Uint8Array(fs.readFileSync(adamPath));
            const text = await extractPdfTextFromBuffer(data);

            assert.match(text, /gradient-based optimization/i);
            assert.match(text, /\bAdam\b/);

            const stats = getPdfStatsFromText(text);
            assert.ok(stats.wordCount > 1000, `expected substantial word count, got ${stats.wordCount}`);
        }
    );

    (hasAdam ? test : test.skip)(
        "getPdfStatsFromBuffer matches text-based stats for adam.pdf",
        async () => {
            const buffer = fs.readFileSync(adamPath);
            const fromBuffer = await getPdfStatsFromBuffer(new Uint8Array(buffer));
            const fromText = getPdfStatsFromText(
                await extractPdfTextFromBuffer(new Uint8Array(buffer))
            );

            assert.deepStrictEqual(fromBuffer, fromText);
        }
    );

    (hasOp2 ? test : test.skip)(
        "separates multi-page PDF text with blank lines",
        async () => {
            const data = new Uint8Array(fs.readFileSync(op2Path));
            const text = await extractPdfTextFromBuffer(data);

            assert.ok(text.includes("\n\n"), "expected page separator between extracted pages");
        }
    );

    test("extractPdfTextFromBuffer rejects invalid PDF data", async () => {
        await assert.rejects(
            () => extractPdfTextFromBuffer(new Uint8Array([1, 2, 3, 4])),
            /Invalid PDF/i
        );
    });
});
