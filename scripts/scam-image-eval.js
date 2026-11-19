#!/usr/bin/env node
/*
 * Scores image files against the real SubQ API with the image scam filter's own request,
 * one image per request, and prints the score and the scam kind per file.
 *
 *   SUBQ_API_KEY=... node scripts/scam-image-eval.js [--threshold 0.3] <file or folder>...
 *
 * The key is read from the environment only. Each image costs 66 to about 1,600 input tokens.
 */

const fs = require('fs');
const path = require('path');
const scamImages = require('../modules/scamImages');
const subq = require('../modules/subq');

const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i;
const WORKERS = 3;

function listFiles(args) {
    const files = [];
    for (const arg of args) {
        if (fs.statSync(arg).isDirectory()) {
            for (const name of fs.readdirSync(arg).sort()) {
                if (IMAGE.test(name)) files.push(path.join(arg, name));
            }
        } else {
            files.push(arg);
        }
    }
    return files;
}

async function main() {
    const args = process.argv.slice(2);
    let threshold = 0.3;
    const inputs = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--threshold') threshold = Number(args[++i]);
        else inputs.push(args[i]);
    }
    if (!process.env.SUBQ_API_KEY || !inputs.length) {
        console.error('Usage: SUBQ_API_KEY=... node scripts/scam-image-eval.js [--threshold 0.3] <file or folder>...');
        process.exit(2);
    }

    const client = subq.createClient({ apiKey: process.env.SUBQ_API_KEY, timeoutMs: 30000 });
    const files = listFiles(inputs);
    const rows = new Array(files.length);
    let next = 0;
    async function worker() {
        while (next < files.length) {
            const index = next++;
            const file = files[index];
            try {
                const image = await scamImages.prepareImage(fs.readFileSync(file));
                const answer = scamImages.readAnswer(await client.decide(scamImages.buildRequest([image])));
                rows[index] = { file, image, answer };
            } catch (error) {
                rows[index] = { file, error: error.message };
            }
        }
    }
    await Promise.all(Array.from({ length: WORKERS }, worker));

    // A miss shows the model's own pick (usually none), a hit the scam kind the filter reports.
    console.log('| file | size sent | score | hit | kind | kind p | tokens |');
    console.log('|--|--|--|--|--|--|--|');
    let hits = 0;
    for (const row of rows) {
        if (row.error) {
            console.log('| ' + path.basename(row.file) + ' | | error: ' + row.error + ' | | | | |');
            continue;
        }
        const { image, answer } = row;
        const hit = answer.score >= threshold;
        if (hit) hits++;
        console.log('| ' + [
            path.basename(row.file),
            image.width + 'x' + image.height + ' ' + image.mediaType.replace('image/', ''),
            answer.score.toFixed(3),
            hit ? 'yes' : 'no',
            hit ? answer.label : answer.choice,
            hit ? (answer.kindProbability === null ? '' : answer.kindProbability.toFixed(2)) : '',
            answer.tokens === null ? '' : answer.tokens
        ].join(' | ') + ' |');
    }
    console.log('\n' + hits + ' of ' + rows.length + ' at or above ' + threshold);
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
