/*
 * File: nbtWriter.js
 * Project: valhalla-updater
 * -----
 * A small binary NBT writer for the `nbt` param of `give_item` ops. The op takes
 * base64 of an UNCOMPRESSED binary NBT compound: the stack's tag.
 *
 * Strings use Java's modified UTF-8, which is what NBTTagString reads. Plain UTF-8
 * differs for U+0000 and for characters outside the BMP (emoji), and the server
 * rejects the whole tag when one of those is wrong.
 *
 * Usage:
 *   const nbt = require('./nbtWriter');
 *   nbt.toBase64(nbt.compound({ SkullOwner: nbt.string('Alp') }));
 */

const TAG = {
    END: 0,
    BYTE: 1,
    SHORT: 2,
    INT: 3,
    LONG: 4,
    STRING: 8,
    LIST: 9,
    COMPOUND: 10
};

const byte = (value) => ({ type: TAG.BYTE, value });
const short = (value) => ({ type: TAG.SHORT, value });
const int = (value) => ({ type: TAG.INT, value });
const long = (value) => ({ type: TAG.LONG, value: BigInt(value) });
const string = (value) => ({ type: TAG.STRING, value: String(value) });

/**
 * A list tag. Every item has the one element type.
 * @param {string} elementType 'byte' | 'short' | 'int' | 'long' | 'string' | 'compound'.
 * @param {Array} items Raw values, or entries maps for 'compound'.
 */
function list(elementType, items) {
    const make = { byte, short, int, long, string, compound }[elementType];
    if (!make) throw new Error(`Unknown NBT list type: ${elementType}`);
    return { type: TAG.LIST, elementType: TAG[elementType.toUpperCase()], value: items.map(make) };
}

/** A compound tag. Undefined and null entries are left out. */
function compound(entries) {
    const value = {};
    for (const [name, tag] of Object.entries(entries)) {
        if (tag !== undefined && tag !== null) value[name] = tag;
    }
    return { type: TAG.COMPOUND, value };
}

/** Java's modified UTF-8: U+0000 takes two bytes, and each UTF-16 surrogate takes three. */
function modifiedUtf8(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0x0001 && c <= 0x007f) {
            bytes.push(c);
        } else if (c <= 0x07ff) {
            bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else {
            bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    if (bytes.length > 65535) throw new Error('NBT string is longer than 65535 bytes');
    return Buffer.from(bytes);
}

function writeString(out, text) {
    const encoded = modifiedUtf8(text);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(encoded.length, 0);
    out.push(length, encoded);
}

function writePayload(out, tag) {
    let buf;
    switch (tag.type) {
        case TAG.BYTE:
            buf = Buffer.alloc(1);
            buf.writeInt8(tag.value, 0);
            out.push(buf);
            return;
        case TAG.SHORT:
            buf = Buffer.alloc(2);
            buf.writeInt16BE(tag.value, 0);
            out.push(buf);
            return;
        case TAG.INT:
            buf = Buffer.alloc(4);
            buf.writeInt32BE(tag.value, 0);
            out.push(buf);
            return;
        case TAG.LONG:
            buf = Buffer.alloc(8);
            buf.writeBigInt64BE(tag.value, 0);
            out.push(buf);
            return;
        case TAG.STRING:
            writeString(out, tag.value);
            return;
        case TAG.LIST:
            // An empty list is written with element type END, as vanilla does.
            buf = Buffer.alloc(5);
            buf.writeUInt8(tag.value.length ? tag.elementType : TAG.END, 0);
            buf.writeInt32BE(tag.value.length, 1);
            out.push(buf);
            for (const item of tag.value) writePayload(out, item);
            return;
        case TAG.COMPOUND:
            for (const [name, child] of Object.entries(tag.value)) {
                out.push(Buffer.from([child.type]));
                writeString(out, name);
                writePayload(out, child);
            }
            out.push(Buffer.from([TAG.END]));
            return;
        default:
            throw new Error(`Unknown NBT tag type: ${tag.type}`);
    }
}

/**
 * Encodes a root compound as uncompressed binary NBT, with an empty root name.
 * @param {object} root A tag made by `compound()`.
 * @returns {Buffer} The bytes.
 */
function encode(root) {
    if (!root || root.type !== TAG.COMPOUND) throw new Error('The NBT root must be a compound');
    const out = [Buffer.from([TAG.COMPOUND])];
    writeString(out, '');
    writePayload(out, root);
    return Buffer.concat(out);
}

/** `encode()` as base64, the form the `give_item` op takes. */
function toBase64(root) {
    return encode(root).toString('base64');
}

module.exports = { TAG, byte, short, int, long, string, list, compound, encode, toBase64, modifiedUtf8 };
