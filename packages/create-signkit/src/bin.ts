#!/usr/bin/env node
import { runCreateSignkit } from './cli/run.js';

const code = await runCreateSignkit({
	argv: process.argv.slice(2),
	stdout: process.stdout,
	stderr: process.stderr,
	env: process.env
});
process.exit(code);
