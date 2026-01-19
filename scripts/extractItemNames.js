/**
 * Extracts item ID → display name mappings from data.bin (NEI dump)
 * The data.bin contains patterns like:
 *   i:mod:item:meta
 *   Display Name
 *   internal_name
 *   tile.mod:item.meta
 */

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const DATA_BIN_PATH = path.join(__dirname, '..', 'data.bin');
const OUTPUT_PATH = path.join(__dirname, '..', 'config', 'itemDisplayNames.json');

async function extractItemNames() {
    console.log('Reading data.bin...');
    const compressedData = fs.readFileSync(DATA_BIN_PATH);
    
    const decompressed = await new Promise((resolve, reject) => {
        zlib.gunzip(compressedData, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
    
    console.log('Decompressed size:', decompressed.length, 'bytes');
    
    // Extract all printable strings (similar to `strings` command)
    const strings = [];
    let currentString = '';
    
    for (let i = 0; i < decompressed.length; i++) {
        const byte = decompressed[i];
        // Printable ASCII range (32-126) plus common extended chars
        if (byte >= 32 && byte <= 126) {
            currentString += String.fromCharCode(byte);
        } else {
            if (currentString.length >= 3) {
                strings.push(currentString);
            }
            currentString = '';
        }
    }
    if (currentString.length >= 3) {
        strings.push(currentString);
    }
    
    console.log('Extracted', strings.length, 'strings');
    
    // Find item entries (i:mod:item:meta pattern) and their display names
    const itemDisplayNames = {};
    const itemPattern = /^i:([a-zA-Z0-9_]+):([a-zA-Z0-9_.\-]+):(\d+)(:.*)?$/;
    
    for (let i = 0; i < strings.length - 1; i++) {
        const match = strings[i].match(itemPattern);
        if (match) {
            const mod = match[1];
            const item = match[2];
            const meta = match[3];
            
            // The display name is typically the next string (if it looks like a name)
            const nextStr = strings[i + 1];
            
            // Skip if next string looks like another item entry or technical string
            if (nextStr && 
                !nextStr.startsWith('i:') && 
                !nextStr.startsWith('r:') &&
                !nextStr.startsWith('f:') &&
                !nextStr.startsWith('o:') &&
                !nextStr.includes('==') &&
                nextStr.length > 1 &&
                nextStr.length < 100 &&
                /^[A-Z]/.test(nextStr)) { // Display names typically start with capital
                
                // Create key in format that matches stats: mod:item or mod:item_meta
                const key = meta === '0' ? `${mod}:${item}` : `${mod}:${item}:${meta}`;
                const keyNoMeta = `${mod}:${item}`;
                
                // Store both with and without meta for flexible lookup
                if (!itemDisplayNames[key]) {
                    itemDisplayNames[key] = nextStr;
                }
                // For meta 0, also store without meta suffix
                if (meta === '0' && !itemDisplayNames[keyNoMeta]) {
                    itemDisplayNames[keyNoMeta] = nextStr;
                }
            }
        }
    }
    
    console.log('Found', Object.keys(itemDisplayNames).length, 'item display names');
    
    // Also add lowercase variants for case-insensitive matching
    const lowercaseMap = {};
    for (const [key, displayName] of Object.entries(itemDisplayNames)) {
        lowercaseMap[key.toLowerCase()] = displayName;
    }
    
    // Merge - lowercase takes precedence for lookups, originals preserved
    const finalMap = { ...lowercaseMap, ...itemDisplayNames };
    
    // Write to file
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(finalMap, null, 2));
    console.log('Written to', OUTPUT_PATH);
    
    // Print some examples
    console.log('\nSample entries:');
    const samples = Object.entries(itemDisplayNames).slice(0, 20);
    samples.forEach(([key, name]) => console.log(`  ${key} => ${name}`));
}

extractItemNames().catch(console.error);
