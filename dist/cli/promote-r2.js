#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalGatewayPath, localId, LocalStoreError } from '../internal/local-store.js';
import { promoteTaskStore } from '../internal/store-promotion.js';
async function run() {
    let directory;
    let taskId;
    let locale;
    try {
        const { values, tokens } = parseArgs({
            options: { directory: { type: 'string' }, 'task-id': { type: 'string' }, 'legacy-digest-locale': { type: 'string' } },
            strict: true, tokens: true, allowPositionals: false,
        });
        const names = new Set();
        for (const token of tokens) {
            if (token.kind !== 'option' || names.has(token.name) || !token.value || token.value.startsWith('--'))
                throw new Error();
            names.add(token.name);
        }
        if (!values.directory || !canonicalGatewayPath(values.directory) || !localId(values['task-id']))
            throw new Error();
        directory = values.directory;
        taskId = values['task-id'];
        locale = values['legacy-digest-locale'];
    }
    catch {
        process.stderr.write('promotion refused: invalid arguments\n');
        process.exitCode = 1;
        return;
    }
    try {
        const generation = await promoteTaskStore(directory, taskId, locale);
        process.stdout.write(`${generation}\n`);
    }
    catch (error) {
        let reason = 'invalid or unavailable history';
        if (error instanceof LocalStoreError)
            reason = error.code;
        else if (error instanceof RangeError || error?.message === 'unsupported-legacy-digest-locale') {
            reason = 'invalid or unsupported legacy digest locale';
        }
        process.stderr.write(`promotion refused: ${reason}\n`);
        process.exitCode = 1;
    }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url))
    await run();
