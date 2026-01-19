/*
 * File: snbtParser.js
 * Project: valhalla-updater
 * File Created: Sunday, 22nd December 2024
 * Author: Valhalla Team
 * -----
 * Parser for SNBT (Stringified NBT) format used by FTB mods
 */

const fs = require('fs-extra');

/**
 * Parses SNBT string to JavaScript object.
 * SNBT uses NBT-like syntax with type suffixes (1L, 0b, 1.0f, etc.)
 * @param {string} snbtString - Raw SNBT content
 * @returns {object} Parsed JavaScript object
 */
function parseSNBT(snbtString) {
    if (!snbtString || typeof snbtString !== 'string') {
        return null;
    }

    try {
        // Step 1: Remove comments (lines starting with // or #)
        let cleaned = snbtString
            .split('\n')
            .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('#'))
            .join('\n');

        // Step 2: Handle SNBT-specific syntax
        // Remove byte suffix (0b, 1b) - convert to boolean-like
        cleaned = cleaned.replace(/:\s*1b\b/g, ': true');
        cleaned = cleaned.replace(/:\s*0b\b/g, ': false');
        
        // Remove long suffix (L) from numbers
        cleaned = cleaned.replace(/:\s*(-?\d+)L\b/g, ': $1');
        cleaned = cleaned.replace(/(\[)\s*(-?\d+)L/g, '$1$2');
        cleaned = cleaned.replace(/,\s*(-?\d+)L\b/g, ', $1');
        
        // Remove float/double suffix (f, d, F, D)
        cleaned = cleaned.replace(/:\s*(-?\d+\.?\d*)[fFdD]\b/g, ': $1');
        
        // Remove short suffix (s, S)
        cleaned = cleaned.replace(/:\s*(-?\d+)[sS]\b/g, ': $1');

        // Step 3: Convert unquoted keys to quoted keys
        // Match pattern: word followed by colon (not inside quotes)
        cleaned = cleaned.replace(/^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/gm, '"$1":');
        cleaned = cleaned.replace(/,\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/g, ', "$1":');
        cleaned = cleaned.replace(/{\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/g, '{ "$1":');
        
        // Step 4: Handle hex-like keys (e.g., 3C782AA288B7A6E3)
        cleaned = cleaned.replace(/^\s*([0-9A-Fa-f]{16})\s*:/gm, '"$1":');
        cleaned = cleaned.replace(/,\s*([0-9A-Fa-f]{16})\s*:/g, ', "$1":');
        cleaned = cleaned.replace(/{\s*([0-9A-Fa-f]{16})\s*:/g, '{ "$1":');

        // Step 5: Handle UUID-format keys
        cleaned = cleaned.replace(/^\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*:/gmi, '"$1":');
        cleaned = cleaned.replace(/,\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*:/gi, ', "$1":');
        cleaned = cleaned.replace(/{\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*:/gi, '{ "$1":');

        // Step 6: Handle empty arrays/objects that might have trailing issues
        cleaned = cleaned.replace(/,\s*}/g, '}');
        cleaned = cleaned.replace(/,\s*]/g, ']');
        
        // Step 7: Remove trailing commas before closing brackets
        cleaned = cleaned.replace(/,(\s*[\]}])/g, '$1');

        return JSON.parse(cleaned);
    } catch (error) {
        // If parsing fails, try a more aggressive cleanup
        try {
            return parseSnbtFallback(snbtString);
        } catch (fallbackError) {
            console.error('SNBT parsing failed:', error.message);
            return null;
        }
    }
}

/**
 * Fallback parser for complex SNBT that the main parser can't handle.
 * Uses regex extraction for key data points.
 * @param {string} snbtString - Raw SNBT content
 * @returns {object} Partially parsed object with key fields
 */
function parseSnbtFallback(snbtString) {
    const result = {};
    
    // Extract UUID
    const uuidMatch = snbtString.match(/uuid:\s*"([^"]+)"/);
    if (uuidMatch) result.uuid = uuidMatch[1];
    
    // Extract name
    const nameMatch = snbtString.match(/name:\s*"([^"]+)"/);
    if (nameMatch) result.name = nameMatch[1];
    
    // Extract player_name
    const playerNameMatch = snbtString.match(/player_name:\s*"([^"]+)"/);
    if (playerNameMatch) result.player_name = playerNameMatch[1];
    
    // Extract completed quests (count hex IDs in completed section)
    const completedMatch = snbtString.match(/completed:\s*\{([^}]*)\}/s);
    if (completedMatch) {
        const completedIds = completedMatch[1].match(/[0-9A-F]{16}/gi);
        result.completed_count = completedIds ? completedIds.length : 0;
    }
    
    // Extract started quests count
    const startedMatch = snbtString.match(/started:\s*\{([^}]*)\}/s);
    if (startedMatch) {
        const startedIds = startedMatch[1].match(/[0-9A-F]{16}/gi);
        result.started_count = startedIds ? startedIds.length : 0;
    }
    
    // Extract chunk counts from FTBChunks format
    const maxClaimMatch = snbtString.match(/max_claim_chunks:\s*(\d+)/);
    if (maxClaimMatch) result.max_claim_chunks = parseInt(maxClaimMatch[1]);
    
    const maxForceMatch = snbtString.match(/max_force_load_chunks:\s*(\d+)/);
    if (maxForceMatch) result.max_force_load_chunks = parseInt(maxForceMatch[1]);
    
    // Count chunks by finding all { x: ..., z: ... } patterns
    const chunkCoordMatches = snbtString.match(/\{\s*x:\s*-?\d+\s*,\s*z:\s*-?\d+/g);
    if (chunkCoordMatches) {
        result.claimed_chunk_count = chunkCoordMatches.length;
    }
    
    // Count force loaded chunks (those with force_loaded: 1b or true)
    const forceLoadedMatches = snbtString.match(/force_loaded:\s*(1b|true)/gi);
    if (forceLoadedMatches) {
        result.force_loaded_chunk_count = forceLoadedMatches.length;
    }
    
    // Extract homes count
    const homesMatch = snbtString.match(/homes:\s*\{([^}]*)\}/s);
    if (homesMatch) {
        // Count home entries by looking for dimension strings
        const homeEntries = homesMatch[1].match(/dim:/g);
        result.homes_count = homeEntries ? homeEntries.length : 0;
    }
    
    // Extract last login time
    const lastLoginMatch = snbtString.match(/last_login_time:\s*(\d+)/);
    if (lastLoginMatch) result.last_login_time = parseInt(lastLoginMatch[1]);
    
    return result;
}

/**
 * Reads and parses an SNBT file.
 * @param {string} filePath - Path to the SNBT file
 * @returns {Promise<object|null>} Parsed object or null if failed
 */
async function readSnbtFile(filePath) {
    try {
        if (!await fs.pathExists(filePath)) {
            return null;
        }
        const content = await fs.readFile(filePath, 'utf-8');
        return parseSNBT(content);
    } catch (error) {
        console.error(`Failed to read SNBT file ${filePath}:`, error.message);
        return null;
    }
}

/**
 * Counts completed quests from FTBQuests SNBT data.
 * @param {object} questData - Parsed FTBQuests SNBT
 * @returns {object} Quest statistics
 */
function extractQuestStats(questData) {
    if (!questData) {
        return { completed: 0, started: 0, claimed_rewards: 0 };
    }
    
    let completed = 0;
    let started = 0;
    let claimedRewards = 0;
    
    // Handle parsed object format
    if (questData.completed) {
        if (typeof questData.completed === 'object') {
            completed = Object.keys(questData.completed).length;
        }
    }
    if (questData.completed_count) {
        completed = questData.completed_count;
    }
    
    if (questData.started) {
        if (typeof questData.started === 'object') {
            started = Object.keys(questData.started).length;
        }
    }
    if (questData.started_count) {
        started = questData.started_count;
    }
    
    if (questData.claimed_rewards) {
        if (typeof questData.claimed_rewards === 'object') {
            claimedRewards = Object.keys(questData.claimed_rewards).length;
        }
    }
    
    return {
        completed,
        started,
        claimed_rewards: claimedRewards,
        in_progress: Math.max(0, started - completed)
    };
}

/**
 * Extracts chunk claim data from FTBChunks SNBT.
 * @param {object} chunkData - Parsed FTBChunks SNBT
 * @returns {object} Chunk statistics
 */
function extractChunkStats(chunkData) {
    if (!chunkData) {
        return { claimed: 0, force_loaded: 0, max_claimed: 0, max_force_loaded: 0 };
    }
    
    let claimed = chunkData.claimed_chunk_count || 0;
    let forceLoaded = chunkData.force_loaded_chunk_count || 0;
    let maxClaimed = chunkData.max_claim_chunks || 500;
    let maxForceLoaded = chunkData.max_force_load_chunks || 25;
    let memberCount = 0;
    
    // If chunks object exists, count manually
    if (chunkData.chunks && typeof chunkData.chunks === 'object') {
        let totalChunks = 0;
        let forceLoadedChunks = 0;
        
        for (const dimension in chunkData.chunks) {
            const dimChunks = chunkData.chunks[dimension];
            if (Array.isArray(dimChunks)) {
                totalChunks += dimChunks.length;
                // Count force loaded chunks (those with force_loaded: true or 1b)
                for (const chunk of dimChunks) {
                    if (chunk.force_loaded === true || chunk.force_loaded === 1) {
                        forceLoadedChunks++;
                    }
                }
            }
        }
        if (totalChunks > 0) claimed = totalChunks;
        if (forceLoadedChunks > 0) forceLoaded = forceLoadedChunks;
    }
    
    // Count team members if member_data exists
    if (chunkData.member_data && typeof chunkData.member_data === 'object') {
        memberCount = Object.keys(chunkData.member_data).length;
    }
    
    return {
        claimed,
        force_loaded: forceLoaded,
        max_claimed: maxClaimed,
        max_force_loaded: maxForceLoaded,
        claim_percentage: maxClaimed > 0 ? Math.round((claimed / maxClaimed) * 100) : 0,
        member_count: memberCount
    };
}

/**
 * Extracts home and essential data from FTBEssentials SNBT.
 * @param {object} essentialsData - Parsed FTBEssentials SNBT
 * @returns {object} Essentials statistics including actual home data for deduplication
 */
function extractEssentialsStats(essentialsData) {
    if (!essentialsData) {
        return { homes_count: 0, homes: [], last_dimension: null };
    }
    
    let homesCount = essentialsData.homes_count || 0;
    let lastDimension = null;
    const homes = [];
    
    if (essentialsData.homes && typeof essentialsData.homes === 'object') {
        // Extract actual home data for deduplication
        for (const [name, homeData] of Object.entries(essentialsData.homes)) {
            if (homeData && typeof homeData === 'object') {
                homes.push({
                    name: name,
                    dim: homeData.dim || 'minecraft:overworld',
                    dimID: getDimIdFromName(homeData.dim),
                    x: Math.floor(homeData.x || 0),
                    y: Math.floor(homeData.y || 0),
                    z: Math.floor(homeData.z || 0)
                });
            }
        }
        homesCount = homes.length;
    }
    
    if (essentialsData.last_seen && essentialsData.last_seen.dim) {
        lastDimension = essentialsData.last_seen.dim;
    }
    
    return {
        homes_count: homesCount,
        homes: homes,
        last_dimension: lastDimension,
        is_flying: essentialsData.fly === true || essentialsData.fly === 1,
        is_god_mode: essentialsData.god === true || essentialsData.god === 1
    };
}

/**
 * Converts dimension name to legacy numeric ID for comparison.
 * @param {string} dimName - Dimension name like "minecraft:overworld"
 * @returns {number} Dimension ID (0=overworld, -1=nether, 1=end, other=custom)
 */
function getDimIdFromName(dimName) {
    if (!dimName) return 0;
    const name = String(dimName).toLowerCase();
    if (name.includes('overworld') || name === '0') return 0;
    if (name.includes('nether') || name === '-1') return -1;
    if (name.includes('the_end') || name.includes('end') || name === '1') return 1;
    // Try to parse as number for legacy formats
    const parsed = parseInt(name);
    if (!isNaN(parsed)) return parsed;
    // Return hash for custom dimensions
    return hashString(name);
}

/**
 * Simple string hash for custom dimension names.
 * @param {string} str - String to hash
 * @returns {number} Hash value
 */
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash;
}

module.exports = {
    parseSNBT,
    parseSnbtFallback,
    readSnbtFile,
    extractQuestStats,
    extractChunkStats,
    extractEssentialsStats,
    getDimIdFromName,
    hashString
};
