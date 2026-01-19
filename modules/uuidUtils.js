/*
 * File: uuidUtils.js
 * Project: valhalla-updater
 * File Created: Sunday, 22nd December 2024
 * Author: Valhalla Team
 * -----
 * UUID conversion utilities for MongoDB Binary UUID and standard formats
 */

const { Buffer } = require('buffer');

/**
 * Converts MongoDB Binary UUID (subtype 03) base64 to standard dashed UUID format.
 * MongoDB stores UUIDs in legacy format with reversed byte order.
 * @param {string} base64String - The base64 encoded UUID from MongoDB
 * @returns {string} Standard dashed UUID format (e.g., "a346a4bc-6df5-6673-b3e9-511fe2a2c48c")
 */
function mongoBase64ToUuid(base64String) {
    const binaryData = Buffer.from(base64String, 'base64');
    
    // Reverse MSB and LSB halves (MongoDB legacy UUID format quirk)
    const msbReversed = binaryData.slice(0, 8).reverse();
    const lsbReversed = binaryData.slice(8, 16).reverse();
    
    const reversedData = Buffer.concat([msbReversed, lsbReversed]);
    
    const hex = reversedData.toString('hex');
    return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`;
}

/**
 * Converts standard dashed UUID to MongoDB Binary UUID base64 format.
 * @param {string} uuidString - Standard UUID (e.g., "a346a4bc-6df5-6673-b3e9-511fe2a2c48c")
 * @returns {string} Base64 encoded UUID for MongoDB storage
 */
function uuidToMongoBase64(uuidString) {
    const hex = uuidString.replace(/-/g, '');
    const uuidBuffer = Buffer.from(hex, 'hex');
    
    // Reverse MSB and LSB halves back to MongoDB format
    const msbOriginal = uuidBuffer.slice(0, 8).reverse();
    const lsbOriginal = uuidBuffer.slice(8, 16).reverse();
    
    const originalData = Buffer.concat([msbOriginal, lsbOriginal]);
    return originalData.toString('base64');
}

/**
 * Converts dashed UUID to undashed format (for Mojang API).
 * @param {string} uuid - Dashed UUID
 * @returns {string} Undashed UUID
 */
function uuidToUndashed(uuid) {
    return uuid.replace(/-/g, '');
}

/**
 * Converts undashed UUID to dashed format.
 * @param {string} uuid - Undashed UUID (32 hex characters)
 * @returns {string} Dashed UUID
 */
function uuidToDashed(uuid) {
    const clean = uuid.replace(/-/g, '').toLowerCase();
    return `${clean.substring(0, 8)}-${clean.substring(8, 12)}-${clean.substring(12, 16)}-${clean.substring(16, 20)}-${clean.substring(20)}`;
}

/**
 * Normalizes a UUID to lowercase dashed format.
 * Handles various input formats (with/without dashes, mixed case).
 * @param {string} uuid - Any UUID format
 * @returns {string} Lowercase dashed UUID
 */
function normalizeUuid(uuid) {
    const clean = uuid.replace(/-/g, '').toLowerCase();
    if (clean.length !== 32) {
        throw new Error(`Invalid UUID length: ${uuid}`);
    }
    return `${clean.substring(0, 8)}-${clean.substring(8, 12)}-${clean.substring(12, 16)}-${clean.substring(16, 20)}-${clean.substring(20)}`;
}

/**
 * Validates if a string is a valid UUID format.
 * @param {string} uuid - String to validate
 * @returns {boolean} True if valid UUID
 */
function isValidUuid(uuid) {
    if (!uuid || typeof uuid !== 'string') return false;
    const clean = uuid.replace(/-/g, '');
    return /^[0-9a-f]{32}$/i.test(clean);
}

/**
 * Fetches Minecraft username from UUID using Mojang API.
 * @param {string} uuid - Player UUID (any format)
 * @returns {Promise<string|null>} Username or null if not found
 */
async function uuidToUsername(uuid) {
    try {
        const undashed = uuidToUndashed(uuid);
        const response = await fetch(`https://api.mojang.com/user/profile/${undashed}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data.name || null;
    } catch (error) {
        console.error(`Failed to fetch username for UUID ${uuid}:`, error.message);
        return null;
    }
}

/**
 * Fetches UUID from Minecraft username using Mojang API.
 * @param {string} username - Player username
 * @returns {Promise<string|null>} Dashed UUID or null if not found
 */
async function usernameToUuid(username) {
    try {
        const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${username}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data.id ? uuidToDashed(data.id) : null;
    } catch (error) {
        console.error(`Failed to fetch UUID for username ${username}:`, error.message);
        return null;
    }
}

module.exports = {
    mongoBase64ToUuid,
    uuidToMongoBase64,
    uuidToUndashed,
    uuidToDashed,
    normalizeUuid,
    isValidUuid,
    uuidToUsername,
    usernameToUuid
};
