import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
    assembleTextFromItems,
    countCharacters,
    countCharactersExcludingSpaces,
    countWords,
    extractPdfTextFromBuffer,
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
    });

    test("countCharacters includes punctuation and whitespace", () => {
        assert.strictEqual(countCharacters("Hello, world — …"), 16);
        assert.strictEqual(countCharacters("a\nb c"), 5);
    });

    test("countCharactersExcludingSpaces removes all whitespace", () => {
        assert.strictEqual(countCharactersExcludingSpaces("Hello, world — …"), 13);
        assert.strictEqual(countCharactersExcludingSpaces("a\nb c"), 3);
    });
});

suite("pdfText real PDF integration", () => {
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
});
