import { defineConfig } from '@vscode/test-cli';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: __dirname,
	mocha: {
		timeout: 30000,
	},
});
