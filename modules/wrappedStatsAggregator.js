/*
 * File: wrappedStatsAggregator.js
 * Project: valhalla-updater
 * File Created: Sunday, 22nd December 2024
 * Author: Valhalla Team
 * -----
 * Aggregates player statistics from all data sources for Wrapped feature
 */

const fs = require('fs-extra');
const path = require('path');
const { normalizeUuid, isValidUuid, uuidToMongoBase64 } = require('./uuidUtils');
const { readSnbtFile, extractQuestStats, extractChunkStats, extractEssentialsStats, parseSNBT, getDimIdFromName } = require('./snbtParser');
const mongo = require('./mongo');

// Load mc-nbt-lib for high-performance NBT file parsing
const minecraftNBT = require('mc-nbt-lib');

// Base path for statistics data
const STATS_BASE_PATH = path.join(__dirname, '../statistics_player_map_info');

// Load item display names from extracted NEI data (if available)
let ITEM_DISPLAY_NAMES = {};
const DISPLAY_NAMES_PATH = path.join(__dirname, '../config/itemDisplayNames.json');
try {
    if (fs.existsSync(DISPLAY_NAMES_PATH)) {
        ITEM_DISPLAY_NAMES = JSON.parse(fs.readFileSync(DISPLAY_NAMES_PATH, 'utf8'));
        console.log(`[WrappedStats] Loaded ${Object.keys(ITEM_DISPLAY_NAMES).length} item display names`);
    }
} catch (err) {
    console.warn('[WrappedStats] Could not load item display names:', err.message);
}

/**
 * Common Minecraft words for splitting compound names.
 * Used to break apart names like "compressedsand" -> "compressed sand"
 */
const COMMON_WORDS = [
    'compressed', 'double', 'triple', 'quadruple', 'octuple',
    'block', 'ore', 'ingot', 'nugget', 'dust', 'plate', 'gear', 'rod', 'wire', 'cable',
    'stone', 'sand', 'gravel', 'dirt', 'clay', 'glass', 'wood', 'log', 'plank', 'planks',
    'iron', 'gold', 'diamond', 'emerald', 'copper', 'tin', 'lead', 'silver', 'steel',
    'coal', 'charcoal', 'redstone', 'lapis', 'quartz', 'obsidian', 'netherrack',
    'sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'bow', 'arrow', 'helmet', 'chestplate', 'leggings', 'boots',
    'bucket', 'chest', 'furnace', 'crafting', 'table', 'torch', 'ladder', 'fence', 'gate', 'door',
    'sapling', 'leaves', 'flower', 'seed', 'seeds', 'crop', 'wheat', 'carrot', 'potato',
    'small', 'large', 'tiny', 'dense', 'pure', 'raw', 'cooked', 'smelted', 'refined',
    'machine', 'generator', 'motor', 'pump', 'pipe', 'tank', 'cell', 'battery',
    'circuit', 'processor', 'chip', 'component', 'module', 'unit', 'frame', 'casing',
    'brick', 'bricks', 'slab', 'stairs', 'wall', 'pillar', 'column',
    'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'white', 'black', 'gray', 'brown',
    'item', 'tile', 'meta', 'basic', 'advanced', 'elite', 'ultimate',
];

/**
 * Formats an internal item name to be human-readable.
 * Handles camelCase, underscores, and adds proper spacing/capitalization.
 * @param {string} name - Internal item name (e.g., "compressedsand", "oak_planks")
 * @returns {string} Formatted name (e.g., "Compressed Sand", "Oak Planks")
 */
function formatItemName(name) {
    if (!name) return 'Unknown';
    
    // Remove minecraft: prefix for cleaner display
    let cleanName = name.replace(/^minecraft:/, '');
    
    // Remove trailing numbers like _0, _1 (metadata)
    cleanName = cleanName.replace(/_\d+$/, '');
    
    // Split camelCase (compressedSand -> compressed Sand)
    cleanName = cleanName.replace(/([a-z])([A-Z])/g, '$1 $2');
    
    // Replace underscores with spaces
    cleanName = cleanName.replace(/_/g, ' ');
    
    // Try to split compound lowercase words using common word list
    // e.g., "compressedsand" -> "compressed sand"
    let words = cleanName.split(' ');
    words = words.flatMap(word => {
        if (word.length > 6 && /^[a-z]+$/.test(word)) {
            // Try to find common words within this compound word
            let remaining = word.toLowerCase();
            const foundWords = [];
            
            while (remaining.length > 0) {
                let matched = false;
                // Try longest words first
                for (const commonWord of COMMON_WORDS.sort((a, b) => b.length - a.length)) {
                    if (remaining.startsWith(commonWord)) {
                        foundWords.push(commonWord);
                        remaining = remaining.slice(commonWord.length);
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    // No common word found, keep the rest as-is
                    if (remaining.length > 0) {
                        foundWords.push(remaining);
                    }
                    break;
                }
            }
            
            return foundWords.length > 1 ? foundWords : [word];
        }
        return [word];
    });
    
    // Capitalize first letter of each word
    cleanName = words
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    
    return cleanName;
}

/**
 * Looks up the display name for an item.
 * First checks the NEI display names database, then falls back to formatting.
 * @param {string} itemId - Item identifier (e.g., "minecraft:stone", "gregtech:gt.blockmachines:791")
 * @returns {string} Human-readable display name
 */
function getItemDisplayName(itemId) {
    if (!itemId) return 'Unknown';
    
    // Try exact match first
    if (ITEM_DISPLAY_NAMES[itemId]) {
        return ITEM_DISPLAY_NAMES[itemId];
    }
    
    // Try lowercase match
    const lowerItemId = itemId.toLowerCase();
    if (ITEM_DISPLAY_NAMES[lowerItemId]) {
        return ITEM_DISPLAY_NAMES[lowerItemId];
    }
    
    // Try without metadata (mod:item instead of mod:item:meta)
    const withoutMeta = itemId.replace(/:\d+$/, '');
    if (ITEM_DISPLAY_NAMES[withoutMeta]) {
        return ITEM_DISPLAY_NAMES[withoutMeta];
    }
    if (ITEM_DISPLAY_NAMES[withoutMeta.toLowerCase()]) {
        return ITEM_DISPLAY_NAMES[withoutMeta.toLowerCase()];
    }
    
    // Try converting stat format (mod.item_meta) to database format (mod:item:meta)
    // Stats use: extrautils2.compressedsand or gregtech.ore_copper_0
    // Database uses: ExtraUtilities:cobblestone_compressed:14
    const parts = itemId.split(':');
    if (parts.length === 2) {
        const mod = parts[0];
        const item = parts[1];
        
        // Check common mod name variations
        const modVariants = [mod, mod.toLowerCase(), mod.charAt(0).toUpperCase() + mod.slice(1)];
        for (const modVar of modVariants) {
            const tryKey = `${modVar}:${item}`;
            if (ITEM_DISPLAY_NAMES[tryKey]) {
                return ITEM_DISPLAY_NAMES[tryKey];
            }
        }
    }
    
    // Fallback: format the item name nicely
    // Extract just the item part if it has a mod prefix
    const itemPart = itemId.includes(':') ? itemId.split(':').pop() : itemId;
    return formatItemName(itemPart);
}

/**
 * Recursively finds all 'stats' folders within a directory up to a certain depth.
 * @param {string} dir - Directory to search
 * @param {number} maxDepth - Maximum recursion depth
 * @param {number} currentDepth - Current depth
 * @returns {Promise<Array<string>>} Array of stats folder paths
 */
async function findStatsFoldersRecursive(dir, maxDepth = 15, currentDepth = 0) {
    const results = [];
    
    if (currentDepth > maxDepth) return results;
    
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            
            const fullPath = path.join(dir, entry.name);
            
            // If this is a 'stats' folder, add it
            if (entry.name === 'stats') {
                results.push(fullPath);
            } else {
                // Recurse into subdirectories (but skip common non-data folders)
                const skipFolders = ['node_modules', '.git', 'logs', 'crash-reports', 'backups', 'schematics', 'mods', 'config', 'scripts', 'kubejs', 'journeymap'];
                if (!skipFolders.includes(entry.name.toLowerCase())) {
                    const subResults = await findStatsFoldersRecursive(fullPath, maxDepth, currentDepth + 1);
                    results.push(...subResults);
                }
            }
        }
    } catch (error) {
        // Ignore permission errors
    }
    
    return results;
}

/**
 * Finds all stats folders recursively in the statistics archive.
 * Handles nested structures like ARI/FTB_AI/stats, vh/VH3/stats, odyssey/world-oldium/stats
 * @returns {Promise<Array<{server: string, statsPath: string, basePath: string, worldFolder: string}>>} Array of server stats locations
 */
async function discoverStatsFolders() {
    const folders = [];
    
    try {
        const serverDirs = await fs.readdir(STATS_BASE_PATH);
        
        for (const serverDir of serverDirs) {
            const serverPath = path.join(STATS_BASE_PATH, serverDir);
            const stat = await fs.stat(serverPath);
            if (!stat.isDirectory()) continue;
            
            // Recursively find all stats folders within this server directory
            const statsFolders = await findStatsFoldersRecursive(serverPath, 3, 0);
            
            for (const statsPath of statsFolders) {
                // Determine the base path (parent of stats folder, which contains ftbquests, ftbchunks, etc.)
                const basePath = path.dirname(statsPath);
                
                // Determine the world folder name (the folder containing stats)
                const relativePath = path.relative(serverPath, basePath);
                const worldFolder = relativePath || 'root';
                
                // Create a unique server identifier
                const serverName = worldFolder === 'root' ? serverDir : `${serverDir}/${worldFolder}`;
                
                folders.push({
                    server: serverDir,
                    serverName: serverName,
                    statsPath,
                    basePath,
                    worldFolder
                });
            }
        }
    } catch (error) {
        console.error('Error discovering stats folders:', error.message);
    }
    
    return folders;
}

/**
 * Reads vanilla Minecraft statistics JSON for a player.
 * @param {string} statsPath - Path to stats folder
 * @param {string} uuid - Player UUID (dashed format)
 * @returns {Promise<object|null>} Parsed stats or null
 */
async function readPlayerStats(statsPath, uuid) {
    const normalizedUuid = normalizeUuid(uuid);
    const filePath = path.join(statsPath, `${normalizedUuid}.json`);
    
    try {
        if (!await fs.pathExists(filePath)) {
            return null;
        }
        const data = await fs.readJson(filePath);
        
        // Handle modern format (nested under stats key)
        if (data.stats) {
            return data.stats;
        }
        
        // Handle legacy format (flat keys like stat.walkOneCm)
        return convertLegacyStats(data);
    } catch (error) {
        return null;
    }
}

/**
 * Legacy 1.7.10 numeric block/item ID to modern name mapping.
 * This covers the most common vanilla Minecraft blocks and items.
 */
const LEGACY_ID_MAP = {
    '0': 'minecraft:air',
    '1': 'minecraft:stone',
    '2': 'minecraft:grass_block',
    '3': 'minecraft:dirt',
    '4': 'minecraft:cobblestone',
    '5': 'minecraft:oak_planks',
    '6': 'minecraft:oak_sapling',
    '7': 'minecraft:bedrock',
    '8': 'minecraft:flowing_water',
    '9': 'minecraft:water',
    '10': 'minecraft:flowing_lava',
    '11': 'minecraft:lava',
    '12': 'minecraft:sand',
    '13': 'minecraft:gravel',
    '14': 'minecraft:gold_ore',
    '15': 'minecraft:iron_ore',
    '16': 'minecraft:coal_ore',
    '17': 'minecraft:oak_log',
    '18': 'minecraft:oak_leaves',
    '19': 'minecraft:sponge',
    '20': 'minecraft:glass',
    '21': 'minecraft:lapis_ore',
    '22': 'minecraft:lapis_block',
    '23': 'minecraft:dispenser',
    '24': 'minecraft:sandstone',
    '25': 'minecraft:note_block',
    '26': 'minecraft:bed',
    '27': 'minecraft:powered_rail',
    '28': 'minecraft:detector_rail',
    '29': 'minecraft:sticky_piston',
    '30': 'minecraft:cobweb',
    '31': 'minecraft:grass',
    '32': 'minecraft:dead_bush',
    '33': 'minecraft:piston',
    '35': 'minecraft:white_wool',
    '37': 'minecraft:dandelion',
    '38': 'minecraft:poppy',
    '39': 'minecraft:brown_mushroom',
    '40': 'minecraft:red_mushroom',
    '41': 'minecraft:gold_block',
    '42': 'minecraft:iron_block',
    '43': 'minecraft:smooth_stone_slab',
    '44': 'minecraft:stone_slab',
    '45': 'minecraft:bricks',
    '46': 'minecraft:tnt',
    '47': 'minecraft:bookshelf',
    '48': 'minecraft:mossy_cobblestone',
    '49': 'minecraft:obsidian',
    '50': 'minecraft:torch',
    '51': 'minecraft:fire',
    '52': 'minecraft:spawner',
    '53': 'minecraft:oak_stairs',
    '54': 'minecraft:chest',
    '55': 'minecraft:redstone_wire',
    '56': 'minecraft:diamond_ore',
    '57': 'minecraft:diamond_block',
    '58': 'minecraft:crafting_table',
    '59': 'minecraft:wheat',
    '60': 'minecraft:farmland',
    '61': 'minecraft:furnace',
    '62': 'minecraft:lit_furnace',
    '63': 'minecraft:sign',
    '64': 'minecraft:oak_door',
    '65': 'minecraft:ladder',
    '66': 'minecraft:rail',
    '67': 'minecraft:cobblestone_stairs',
    '68': 'minecraft:wall_sign',
    '69': 'minecraft:lever',
    '70': 'minecraft:stone_pressure_plate',
    '71': 'minecraft:iron_door',
    '72': 'minecraft:oak_pressure_plate',
    '73': 'minecraft:redstone_ore',
    '74': 'minecraft:lit_redstone_ore',
    '75': 'minecraft:unlit_redstone_torch',
    '76': 'minecraft:redstone_torch',
    '77': 'minecraft:stone_button',
    '78': 'minecraft:snow',
    '79': 'minecraft:ice',
    '80': 'minecraft:snow_block',
    '81': 'minecraft:cactus',
    '82': 'minecraft:clay',
    '83': 'minecraft:sugar_cane',
    '84': 'minecraft:jukebox',
    '85': 'minecraft:oak_fence',
    '86': 'minecraft:pumpkin',
    '87': 'minecraft:netherrack',
    '88': 'minecraft:soul_sand',
    '89': 'minecraft:glowstone',
    '90': 'minecraft:nether_portal',
    '91': 'minecraft:jack_o_lantern',
    '92': 'minecraft:cake',
    '95': 'minecraft:white_stained_glass',
    '96': 'minecraft:trapdoor',
    '97': 'minecraft:infested_stone',
    '98': 'minecraft:stone_bricks',
    '99': 'minecraft:brown_mushroom_block',
    '100': 'minecraft:red_mushroom_block',
    '101': 'minecraft:iron_bars',
    '102': 'minecraft:glass_pane',
    '103': 'minecraft:melon',
    '106': 'minecraft:vine',
    '107': 'minecraft:oak_fence_gate',
    '108': 'minecraft:brick_stairs',
    '109': 'minecraft:stone_brick_stairs',
    '110': 'minecraft:mycelium',
    '111': 'minecraft:lily_pad',
    '112': 'minecraft:nether_bricks',
    '113': 'minecraft:nether_brick_fence',
    '114': 'minecraft:nether_brick_stairs',
    '115': 'minecraft:nether_wart',
    '116': 'minecraft:enchanting_table',
    '117': 'minecraft:brewing_stand',
    '118': 'minecraft:cauldron',
    '119': 'minecraft:end_portal',
    '120': 'minecraft:end_portal_frame',
    '121': 'minecraft:end_stone',
    '122': 'minecraft:dragon_egg',
    '123': 'minecraft:redstone_lamp',
    '124': 'minecraft:lit_redstone_lamp',
    '125': 'minecraft:oak_slab',
    '126': 'minecraft:oak_slab',
    '127': 'minecraft:cocoa',
    '128': 'minecraft:sandstone_stairs',
    '129': 'minecraft:emerald_ore',
    '130': 'minecraft:ender_chest',
    '131': 'minecraft:tripwire_hook',
    '132': 'minecraft:tripwire',
    '133': 'minecraft:emerald_block',
    '134': 'minecraft:spruce_stairs',
    '135': 'minecraft:birch_stairs',
    '136': 'minecraft:jungle_stairs',
    '137': 'minecraft:command_block',
    '138': 'minecraft:beacon',
    '139': 'minecraft:cobblestone_wall',
    '140': 'minecraft:flower_pot',
    '141': 'minecraft:carrots',
    '142': 'minecraft:potatoes',
    '143': 'minecraft:oak_button',
    '144': 'minecraft:skeleton_skull',
    '145': 'minecraft:anvil',
    '146': 'minecraft:trapped_chest',
    '147': 'minecraft:light_weighted_pressure_plate',
    '148': 'minecraft:heavy_weighted_pressure_plate',
    '149': 'minecraft:comparator',
    '150': 'minecraft:powered_comparator',
    '151': 'minecraft:daylight_detector',
    '152': 'minecraft:redstone_block',
    '153': 'minecraft:nether_quartz_ore',
    '154': 'minecraft:hopper',
    '155': 'minecraft:quartz_block',
    '156': 'minecraft:quartz_stairs',
    '157': 'minecraft:activator_rail',
    '158': 'minecraft:dropper',
    '159': 'minecraft:white_terracotta',
    '160': 'minecraft:white_stained_glass_pane',
    '161': 'minecraft:acacia_leaves',
    '162': 'minecraft:acacia_log',
    '163': 'minecraft:acacia_stairs',
    '164': 'minecraft:dark_oak_stairs',
    '165': 'minecraft:slime_block',
    '166': 'minecraft:barrier',
    '167': 'minecraft:iron_trapdoor',
    '168': 'minecraft:prismarine',
    '169': 'minecraft:sea_lantern',
    '170': 'minecraft:hay_block',
    '171': 'minecraft:white_carpet',
    '172': 'minecraft:terracotta',
    '173': 'minecraft:coal_block',
    '174': 'minecraft:packed_ice',
    '175': 'minecraft:sunflower',
    // Common items
    '256': 'minecraft:iron_shovel',
    '257': 'minecraft:iron_pickaxe',
    '258': 'minecraft:iron_axe',
    '259': 'minecraft:flint_and_steel',
    '260': 'minecraft:apple',
    '261': 'minecraft:bow',
    '262': 'minecraft:arrow',
    '263': 'minecraft:coal',
    '264': 'minecraft:diamond',
    '265': 'minecraft:iron_ingot',
    '266': 'minecraft:gold_ingot',
    '267': 'minecraft:iron_sword',
    '268': 'minecraft:wooden_sword',
    '269': 'minecraft:wooden_shovel',
    '270': 'minecraft:wooden_pickaxe',
    '271': 'minecraft:wooden_axe',
    '272': 'minecraft:stone_sword',
    '273': 'minecraft:stone_shovel',
    '274': 'minecraft:stone_pickaxe',
    '275': 'minecraft:stone_axe',
    '276': 'minecraft:diamond_sword',
    '277': 'minecraft:diamond_shovel',
    '278': 'minecraft:diamond_pickaxe',
    '279': 'minecraft:diamond_axe',
    '280': 'minecraft:stick',
    '281': 'minecraft:bowl',
    '282': 'minecraft:mushroom_stew',
    '283': 'minecraft:golden_sword',
    '284': 'minecraft:golden_shovel',
    '285': 'minecraft:golden_pickaxe',
    '286': 'minecraft:golden_axe',
    '287': 'minecraft:string',
    '288': 'minecraft:feather',
    '289': 'minecraft:gunpowder',
    '290': 'minecraft:wooden_hoe',
    '291': 'minecraft:stone_hoe',
    '292': 'minecraft:iron_hoe',
    '293': 'minecraft:diamond_hoe',
    '294': 'minecraft:golden_hoe',
    '295': 'minecraft:wheat_seeds',
    '296': 'minecraft:wheat',
    '297': 'minecraft:bread',
    '298': 'minecraft:leather_helmet',
    '299': 'minecraft:leather_chestplate',
    '300': 'minecraft:leather_leggings',
    '301': 'minecraft:leather_boots',
    '302': 'minecraft:chainmail_helmet',
    '303': 'minecraft:chainmail_chestplate',
    '304': 'minecraft:chainmail_leggings',
    '305': 'minecraft:chainmail_boots',
    '306': 'minecraft:iron_helmet',
    '307': 'minecraft:iron_chestplate',
    '308': 'minecraft:iron_leggings',
    '309': 'minecraft:iron_boots',
    '310': 'minecraft:diamond_helmet',
    '311': 'minecraft:diamond_chestplate',
    '312': 'minecraft:diamond_leggings',
    '313': 'minecraft:diamond_boots',
    '314': 'minecraft:golden_helmet',
    '315': 'minecraft:golden_chestplate',
    '316': 'minecraft:golden_leggings',
    '317': 'minecraft:golden_boots',
    '318': 'minecraft:flint',
    '319': 'minecraft:porkchop',
    '320': 'minecraft:cooked_porkchop',
    '321': 'minecraft:painting',
    '322': 'minecraft:golden_apple',
    '323': 'minecraft:sign',
    '324': 'minecraft:oak_door',
    '325': 'minecraft:bucket',
    '326': 'minecraft:water_bucket',
    '327': 'minecraft:lava_bucket',
    '328': 'minecraft:minecart',
    '329': 'minecraft:saddle',
    '330': 'minecraft:iron_door',
    '331': 'minecraft:redstone',
    '332': 'minecraft:snowball',
    '333': 'minecraft:oak_boat',
    '334': 'minecraft:leather',
    '335': 'minecraft:milk_bucket',
    '336': 'minecraft:brick',
    '337': 'minecraft:clay_ball',
    '338': 'minecraft:sugar_cane',
    '339': 'minecraft:paper',
    '340': 'minecraft:book',
    '341': 'minecraft:slime_ball',
    '342': 'minecraft:chest_minecart',
    '343': 'minecraft:furnace_minecart',
    '344': 'minecraft:egg',
    '345': 'minecraft:compass',
    '346': 'minecraft:fishing_rod',
    '347': 'minecraft:clock',
    '348': 'minecraft:glowstone_dust',
    '349': 'minecraft:cod',
    '350': 'minecraft:cooked_cod',
    '351': 'minecraft:ink_sac',
    '352': 'minecraft:bone',
    '353': 'minecraft:sugar',
    '354': 'minecraft:cake',
    '355': 'minecraft:bed',
    '356': 'minecraft:repeater',
    '357': 'minecraft:cookie',
    '358': 'minecraft:filled_map',
    '359': 'minecraft:shears',
    '360': 'minecraft:melon_slice',
    '361': 'minecraft:pumpkin_seeds',
    '362': 'minecraft:melon_seeds',
    '363': 'minecraft:beef',
    '364': 'minecraft:cooked_beef',
    '365': 'minecraft:chicken',
    '366': 'minecraft:cooked_chicken',
    '367': 'minecraft:rotten_flesh',
    '368': 'minecraft:ender_pearl',
    '369': 'minecraft:blaze_rod',
    '370': 'minecraft:ghast_tear',
    '371': 'minecraft:gold_nugget',
    '372': 'minecraft:nether_wart',
    '373': 'minecraft:potion',
    '374': 'minecraft:glass_bottle',
    '375': 'minecraft:spider_eye',
    '376': 'minecraft:fermented_spider_eye',
    '377': 'minecraft:blaze_powder',
    '378': 'minecraft:magma_cream',
    '379': 'minecraft:brewing_stand',
    '380': 'minecraft:cauldron',
    '381': 'minecraft:ender_eye',
    '382': 'minecraft:glistering_melon_slice',
    '383': 'minecraft:spawn_egg',
    '384': 'minecraft:experience_bottle',
    '385': 'minecraft:fire_charge',
    '386': 'minecraft:writable_book',
    '387': 'minecraft:written_book',
    '388': 'minecraft:emerald',
    '389': 'minecraft:item_frame',
    '390': 'minecraft:flower_pot',
    '391': 'minecraft:carrot',
    '392': 'minecraft:potato',
    '393': 'minecraft:baked_potato',
    '394': 'minecraft:poisonous_potato',
    '395': 'minecraft:map',
    '396': 'minecraft:golden_carrot',
    '397': 'minecraft:skeleton_skull',
    '398': 'minecraft:carrot_on_a_stick',
    '399': 'minecraft:nether_star',
    '400': 'minecraft:pumpkin_pie',
    '401': 'minecraft:firework_rocket',
    '402': 'minecraft:firework_star',
    '403': 'minecraft:enchanted_book',
    '404': 'minecraft:comparator',
    '405': 'minecraft:nether_brick',
    '406': 'minecraft:quartz',
    '407': 'minecraft:tnt_minecart',
    '408': 'minecraft:hopper_minecart',
    '409': 'minecraft:prismarine_shard',
    '410': 'minecraft:prismarine_crystals',
    '411': 'minecraft:rabbit',
    '412': 'minecraft:cooked_rabbit',
    '413': 'minecraft:rabbit_stew',
    '414': 'minecraft:rabbit_foot',
    '415': 'minecraft:rabbit_hide',
    '416': 'minecraft:armor_stand',
    '417': 'minecraft:iron_horse_armor',
    '418': 'minecraft:golden_horse_armor',
    '419': 'minecraft:diamond_horse_armor',
    '420': 'minecraft:lead',
    '421': 'minecraft:name_tag',
    '422': 'minecraft:command_block_minecart',
    '423': 'minecraft:mutton',
    '424': 'minecraft:cooked_mutton',
    '425': 'minecraft:white_banner',
    '427': 'minecraft:spruce_door',
    '428': 'minecraft:birch_door',
    '429': 'minecraft:jungle_door',
    '430': 'minecraft:acacia_door',
    '431': 'minecraft:dark_oak_door',
    '2256': 'minecraft:music_disc_13',
    '2257': 'minecraft:music_disc_cat',
    '2258': 'minecraft:music_disc_blocks',
    '2259': 'minecraft:music_disc_chirp',
    '2260': 'minecraft:music_disc_far',
    '2261': 'minecraft:music_disc_mall',
    '2262': 'minecraft:music_disc_mellohi',
    '2263': 'minecraft:music_disc_stal',
    '2264': 'minecraft:music_disc_strad',
    '2265': 'minecraft:music_disc_ward',
    '2266': 'minecraft:music_disc_11',
    '2267': 'minecraft:music_disc_wait',
};

/**
 * Converts a legacy 1.7.10 numeric block/item ID to modern name.
 * @param {string} id - The ID to convert (could be "1", "minecraft:1", etc.)
 * @returns {string} Modern name or original if not found
 */
function convertLegacyId(id) {
    if (!id) return id;
    const str = String(id);
    
    // Already has a proper name (not just a number)
    if (str.includes(':') && !/^[a-z_]+:\d+$/.test(str)) {
        return str;
    }
    
    // Extract the numeric part
    let numericId = str;
    if (str.includes(':')) {
        numericId = str.split(':')[1];
    }
    
    // Check if it's a pure number
    if (/^\d+$/.test(numericId)) {
        return LEGACY_ID_MAP[numericId] || `minecraft:unknown_${numericId}`;
    }
    
    return str;
}

/**
 * Checks if an item is an air block that should be filtered from statistics.
 * Handles both modern format (minecraft:air) and legacy 1.7.10 numeric IDs.
 * @param {string} itemName - Item name/ID to check
 * @returns {boolean} True if the item is air and should be filtered
 */
function isAirItem(itemName) {
    if (!itemName) return true;
    const name = String(itemName).toLowerCase();
    // Modern format: minecraft:air, minecraft:cave_air, minecraft:void_air
    if (name === 'minecraft:air' || name === 'minecraft:cave_air' || name === 'minecraft:void_air') {
        return true;
    }
    // Legacy 1.7.10 format: numeric ID 0 is air (e.g., "0" or "autogen.0")
    if (name === '0' || name.endsWith(':0') || name === 'autogen:0' || name === 'autogen.0') {
        return true;
    }
    // Some mods use just "air" without namespace
    if (name === 'air' || name.endsWith(':air')) {
        return true;
    }
    return false;
}

/**
 * Converts legacy 1.7.10 stats format to modern nested format.
 * @param {object} legacyStats - Legacy flat stats object
 * @returns {object} Modern nested format
 */
function convertLegacyStats(legacyStats) {
    const modern = {
        'minecraft:custom': {},
        'minecraft:mined': {},
        'minecraft:crafted': {},
        'minecraft:used': {},
        'minecraft:picked_up': {},
        'minecraft:dropped': {},
        'minecraft:killed': {},
        'minecraft:killed_by': {}
    };
    
    const keyMappings = {
        'stat.walkOneCm': ['minecraft:custom', 'minecraft:walk_one_cm'],
        'stat.flyOneCm': ['minecraft:custom', 'minecraft:fly_one_cm'],
        'stat.swimOneCm': ['minecraft:custom', 'minecraft:swim_one_cm'],
        'stat.sprintOneCm': ['minecraft:custom', 'minecraft:sprint_one_cm'],
        'stat.crouchOneCm': ['minecraft:custom', 'minecraft:crouch_one_cm'],
        'stat.fallOneCm': ['minecraft:custom', 'minecraft:fall_one_cm'],
        'stat.climbOneCm': ['minecraft:custom', 'minecraft:climb_one_cm'],
        'stat.jump': ['minecraft:custom', 'minecraft:jump'],
        'stat.deaths': ['minecraft:custom', 'minecraft:deaths'],
        'stat.mobKills': ['minecraft:custom', 'minecraft:mob_kills'],
        'stat.playerKills': ['minecraft:custom', 'minecraft:player_kills'],
        'stat.damageDealt': ['minecraft:custom', 'minecraft:damage_dealt'],
        'stat.damageTaken': ['minecraft:custom', 'minecraft:damage_taken'],
        'stat.playOneMinute': ['minecraft:custom', 'minecraft:play_time'], // Actually ticks
        'stat.leaveGame': ['minecraft:custom', 'minecraft:leave_game'],
        'stat.timeSinceDeath': ['minecraft:custom', 'minecraft:time_since_death'],
        'stat.timeSinceRest': ['minecraft:custom', 'minecraft:time_since_rest'],
        'stat.animalsBred': ['minecraft:custom', 'minecraft:animals_bred'],
        'stat.fishCaught': ['minecraft:custom', 'minecraft:fish_caught'],
    };
    
    for (const [legacyKey, [category, modernKey]] of Object.entries(keyMappings)) {
        if (legacyStats[legacyKey] !== undefined) {
            if (!modern[category]) modern[category] = {};
            modern[category][modernKey] = legacyStats[legacyKey];
        }
    }
    
    // Handle dynamic keys like stat.mineBlock.minecraft.stone or stat.mineBlock.1
    for (const [key, value] of Object.entries(legacyStats)) {
        if (typeof value !== 'number') continue;
        
        if (key.startsWith('stat.mineBlock.')) {
            let block = key.replace('stat.mineBlock.', '').replace('.', ':');
            block = convertLegacyId(block); // Convert numeric IDs to names
            modern['minecraft:mined'][block] = value;
        } else if (key.startsWith('stat.craftItem.')) {
            let item = key.replace('stat.craftItem.', '').replace('.', ':');
            item = convertLegacyId(item); // Convert numeric IDs to names
            modern['minecraft:crafted'][item] = value;
        } else if (key.startsWith('stat.useItem.')) {
            let item = key.replace('stat.useItem.', '').replace('.', ':');
            item = convertLegacyId(item); // Convert numeric IDs to names
            modern['minecraft:used'][item] = value;
        } else if (key.startsWith('stat.pickup.')) {
            let item = key.replace('stat.pickup.', '').replace('.', ':');
            item = convertLegacyId(item); // Convert numeric IDs to names
            modern['minecraft:picked_up'][item] = value;
        } else if (key.startsWith('stat.drop.')) {
            let item = key.replace('stat.drop.', '').replace('.', ':');
            item = convertLegacyId(item); // Convert numeric IDs to names
            modern['minecraft:dropped'][item] = value;
        } else if (key.startsWith('stat.killEntity.')) {
            const entity = key.replace('stat.killEntity.', '').replace('.', ':');
            modern['minecraft:killed'][entity] = value;
        } else if (key.startsWith('stat.entityKilledBy.')) {
            const entity = key.replace('stat.entityKilledBy.', '').replace('.', ':');
            modern['minecraft:killed_by'][entity] = value;
        }
    }
    
    return modern;
}

/**
 * Finds FTBQuests data for a player.
 * Searches in multiple possible locations and handles both player_data and root folder structures.
 * @param {string} basePath - Server base path
 * @param {string} uuid - Player UUID
 * @returns {Promise<object|null>} Quest stats
 */
async function findFtbQuestsData(basePath, uuid) {
    const normalizedUuid = normalizeUuid(uuid);
    const undashedUuid = uuid.replace(/-/g, '');
    
    const possiblePaths = [
        // Modern FTBQuests (1.16+) - player_data subfolder
        path.join(basePath, 'ftbquests/player_data', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbquests/player_data', `${undashedUuid}.snbt`),
        // Root ftbquests folder (some versions)
        path.join(basePath, 'ftbquests', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbquests', `${undashedUuid}.snbt`),
        // World subfolder variants
        path.join(basePath, 'world/ftbquests/player_data', `${normalizedUuid}.snbt`),
        path.join(basePath, 'world/ftbquests/player_data', `${undashedUuid}.snbt`),
        path.join(basePath, 'world/ftbquests', `${normalizedUuid}.snbt`),
        path.join(basePath, 'world/ftbquests', `${undashedUuid}.snbt`),
    ];
    
    for (const filePath of possiblePaths) {
        const data = await readSnbtFile(filePath);
        if (data) {
            return extractQuestStats(data);
        }
    }
    
    return null;
}

/**
 * Finds BetterQuesting data for a player (legacy 1.7.10-1.12).
 * Handles both per-player JSON files (GTNH format) and single QuestProgress.json format.
 * @param {string} basePath - Server base path
 * @param {string} uuid - Player UUID
 * @returns {Promise<object|null>} Quest stats
 */
async function findBetterQuestingData(basePath, uuid) {
    const normalizedUuid = normalizeUuid(uuid);
    
    // Possible BetterQuesting folder locations
    const possiblePaths = [
        path.join(basePath, 'betterquesting'),
        path.join(basePath, 'world/betterquesting'),
        path.join(basePath, 'DregoraRL/betterquesting'),
        path.join(basePath, 'World/betterquesting'),
    ];
    
    for (const questPath of possiblePaths) {
        if (!await fs.pathExists(questPath)) continue;
        
        // METHOD 1: Check for per-player JSON files in QuestProgress folder (GTNH format)
        const perPlayerPath = path.join(questPath, 'QuestProgress', `${normalizedUuid}.json`);
        if (await fs.pathExists(perPlayerPath)) {
            try {
                const playerProgress = await fs.readJson(perPlayerPath);
                return parseBetterQuestingPlayerFile(playerProgress, normalizedUuid);
            } catch (error) {
                // Continue to next method
            }
        }
        
        // METHOD 2: Check single QuestProgress.json file (older format)
        const progressPath = path.join(questPath, 'QuestProgress.json');
        if (await fs.pathExists(progressPath)) {
            try {
                const progressData = await fs.readJson(progressPath);
                return parseBetterQuestingMainFile(progressData, normalizedUuid);
            } catch (error) {
                continue;
            }
        }
    }
    
    return null;
}

/**
 * Parses a per-player BetterQuesting JSON file (GTNH format).
 * @param {object} playerProgress - Player's quest progress data
 * @param {string} uuid - Player UUID
 * @returns {object} Quest stats
 */
function parseBetterQuestingPlayerFile(playerProgress, uuid) {
    let completed = 0;
    let started = 0;
    
    const questProgress = playerProgress['questProgress:9'];
    if (questProgress) {
        for (const questKey in questProgress) {
            const quest = questProgress[questKey];
            
            // Check if quest is completed by this player
            const completedList = quest['completed:9'];
            if (completedList) {
                // In per-player files, if completed:9 has any entries, the quest is completed
                const completedEntries = Object.keys(completedList).length;
                if (completedEntries > 0) {
                    // Check if this player is in the completed list
                    for (const completeKey in completedList) {
                        const entry = completedList[completeKey];
                        if (entry['uuid:8'] && entry['uuid:8'].toLowerCase() === uuid.toLowerCase()) {
                            completed++;
                            break;
                        }
                    }
                }
            }
            
            // Check task progress to count started quests
            const tasks = quest['tasks:9'];
            if (tasks) {
                let hasProgress = false;
                for (const taskKey in tasks) {
                    const task = tasks[taskKey];
                    
                    // Check completeUsers
                    const completeUsers = task['completeUsers:9'];
                    if (completeUsers && Object.keys(completeUsers).length > 0) {
                        hasProgress = true;
                        break;
                    }
                    
                    // Check userProgress
                    const userProgress = task['userProgress:9'];
                    if (userProgress) {
                        for (const progressKey in userProgress) {
                            const progress = userProgress[progressKey];
                            if (progress['uuid:8'] && progress['uuid:8'].toLowerCase() === uuid.toLowerCase()) {
                                hasProgress = true;
                                break;
                            }
                        }
                    }
                    if (hasProgress) break;
                }
                if (hasProgress) started++;
            }
        }
    }
    
    return {
        completed,
        started: Math.max(started, completed),
        claimed_rewards: 0,
        in_progress: Math.max(0, started - completed)
    };
}

/**
 * Parses the main QuestProgress.json file (older BetterQuesting format).
 * @param {object} progressData - Main quest progress data
 * @param {string} uuid - Player UUID
 * @returns {object} Quest stats
 */
function parseBetterQuestingMainFile(progressData, uuid) {
    let completed = 0;
    let started = 0;
    
    const questProgress = progressData['questProgress:9'];
    if (questProgress) {
        for (const questKey in questProgress) {
            const quest = questProgress[questKey];
            const completedList = quest['completed:9'];
            
            if (completedList) {
                for (const completeKey in completedList) {
                    const entry = completedList[completeKey];
                    if (entry['uuid:8'] && entry['uuid:8'].toLowerCase() === uuid.toLowerCase()) {
                        completed++;
                        break;
                    }
                }
            }
            
            // Check task progress for started
            const tasks = quest['tasks:9'];
            if (tasks) {
                for (const taskKey in tasks) {
                    const task = tasks[taskKey];
                    const userProgress = task['userProgress:9'];
                    if (userProgress) {
                        for (const progressKey in userProgress) {
                            const progress = userProgress[progressKey];
                            if (progress['uuid:8'] && progress['uuid:8'].toLowerCase() === uuid.toLowerCase()) {
                                started++;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
    
    return {
        completed,
        started: Math.max(started, completed),
        claimed_rewards: 0,
        in_progress: Math.max(0, started - completed)
    };
}

/**
 * Finds FTBChunks data for a player.
 * Searches claimed folder and handles team-based claiming.
 * @param {string} basePath - Server base path
 * @param {string} uuid - Player UUID
 * @returns {Promise<object|null>} Chunk stats
 */
async function findFtbChunksData(basePath, uuid) {
    const normalizedUuid = normalizeUuid(uuid);
    const undashedUuid = uuid.replace(/-/g, '');
    
    const possiblePaths = [
        // Direct player claims
        path.join(basePath, 'ftbchunks/claimed', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbchunks/claimed', `${undashedUuid}.snbt`),
        path.join(basePath, 'ftbchunks', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbchunks', `${undashedUuid}.snbt`),
        // World subfolder variants
        path.join(basePath, 'world/ftbchunks/claimed', `${normalizedUuid}.snbt`),
        path.join(basePath, 'world/ftbchunks/claimed', `${undashedUuid}.snbt`),
        path.join(basePath, 'world/ftbchunks', `${normalizedUuid}.snbt`),
        path.join(basePath, 'world/ftbchunks', `${undashedUuid}.snbt`),
    ];
    
    for (const filePath of possiblePaths) {
        const data = await readSnbtFile(filePath);
        if (data) {
            return extractChunkStats(data);
        }
    }
    
    // Try to find team-based claims via FTBTeams
    const teamsData = await findFtbTeamsData(basePath, uuid);
    if (teamsData && teamsData.team_id) {
        // Check if there are team claims under the party ID
        const teamClaimPaths = [
            path.join(basePath, 'ftbchunks/claimed', `${teamsData.team_id}.snbt`),
            path.join(basePath, 'world/ftbchunks/claimed', `${teamsData.team_id}.snbt`),
        ];
        
        for (const filePath of teamClaimPaths) {
            const data = await readSnbtFile(filePath);
            if (data) {
                const stats = extractChunkStats(data);
                stats.is_team_claim = true;
                stats.team_id = teamsData.team_id;
                return stats;
            }
        }
    }
    
    return null;
}

/**
 * Finds LatMod claimed chunks data (legacy).
 * @param {string} basePath - Server base path
 * @param {string} uuid - Player UUID
 * @returns {Promise<object|null>} Chunk stats
 */
async function findLatModChunksData(basePath, uuid) {
    const possiblePaths = [
        path.join(basePath, 'LatMod/ClaimedChunks.json'),
        path.join(basePath, 'world/LatMod/ClaimedChunks.json'),
    ];
    
    const normalizedUuid = uuid.replace(/-/g, '').toLowerCase();
    
    for (const filePath of possiblePaths) {
        if (!await fs.pathExists(filePath)) continue;
        
        try {
            const data = await fs.readJson(filePath);
            let totalClaimed = 0;
            
            // Structure: { "dimensionId": { "uuid": [[x,z], [x,z]] } }
            for (const dimId in data) {
                const dimension = data[dimId];
                if (typeof dimension === 'object') {
                    for (const playerUuid in dimension) {
                        if (playerUuid.toLowerCase() === normalizedUuid) {
                            const chunks = dimension[playerUuid];
                            if (Array.isArray(chunks)) {
                                totalClaimed += chunks.length;
                            }
                        }
                    }
                }
            }
            
            if (totalClaimed > 0) {
                return {
                    claimed: totalClaimed,
                    force_loaded: 0,
                    max_claimed: 0,
                    max_force_loaded: 0,
                    claim_percentage: 0
                };
            }
        } catch (error) {
            continue;
        }
    }
    
    return null;
}

/**
 * Finds FTBEssentials data for a player.
 * @param {string} basePath - Server base path
 * @param {string} uuid - Player UUID
 * @returns {Promise<object|null>} Essentials stats
 */
async function findFtbEssentialsData(basePath, uuid) {
    const normalizedUuid = normalizeUuid(uuid);
    const undashedUuid = uuid.replace(/-/g, '');
    
    const possiblePaths = [
        path.join(basePath, 'ftbessentials/playerdata', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbessentials/playerdata', `${undashedUuid}.snbt`),
        path.join(basePath, 'ftbessentials', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbessentials', `${undashedUuid}.snbt`),
        // World subfolder variants
        path.join(basePath, 'world/ftbessentials/playerdata', `${normalizedUuid}.snbt`),
        path.join(basePath, 'world/ftbessentials/playerdata', `${undashedUuid}.snbt`),
        path.join(basePath, 'world/ftbessentials', `${normalizedUuid}.snbt`),
        path.join(basePath, 'world/ftbessentials', `${undashedUuid}.snbt`),
    ];
    
    for (const filePath of possiblePaths) {
        const data = await readSnbtFile(filePath);
        if (data) {
            return extractEssentialsStats(data);
        }
    }
    
    return null;
}

/**
 * Finds FTBTeams data for a player.
 * @param {string} basePath - Server base path
 * @param {string} uuid - Player UUID
 * @returns {Promise<object|null>} Team info
 */
async function findFtbTeamsData(basePath, uuid) {
    const normalizedUuid = normalizeUuid(uuid);
    const undashedUuid = uuid.replace(/-/g, '');
    
    const possiblePaths = [
        path.join(basePath, 'ftbteams/player', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbteams/player', `${undashedUuid}.snbt`),
        // World subfolder variants
        path.join(basePath, 'world/ftbteams/player', `${normalizedUuid}.snbt`),
        path.join(basePath, 'world/ftbteams/player', `${undashedUuid}.snbt`),
    ];
    
    for (const filePath of possiblePaths) {
        const data = await readSnbtFile(filePath);
        if (data) {
            return {
                team_id: data.id || data.team,
                team_type: data.type,
                player_name: data.player_name || data.name,
                is_owner: data.ranks && Object.values(data.ranks).includes('owner'),
                profile: data.profile
            };
        }
    }
    
    return null;
}

/**
 * Finds homes from LMPlayers.dat (legacy LatMod format, 1.7.10-1.12).
 * Format: Binary NBT with Players.{id}.Homes.{name} = [I; x, y, z, dimID]
 * @param {string} basePath - Server base path
 * @param {string} uuid - Player UUID (undashed format for comparison)
 * @returns {Promise<Array>} Array of home objects {name, x, y, z, dimID}
 */
async function findLMPlayersHomes(basePath, uuid) {
    const homes = [];
    const normalizedUuid = uuid.replace(/-/g, '').toLowerCase();
    
    const possiblePaths = [
        path.join(basePath, 'LatMod/LMPlayers.dat'),
        path.join(basePath, 'world/LatMod/LMPlayers.dat'),
        path.join(basePath, 'World/LatMod/LMPlayers.dat'),
    ];
    
    for (const filePath of possiblePaths) {
        if (!await fs.pathExists(filePath)) continue;
        
        try {
            // Read NBT file using nbt-ts or external process
            const nbtData = await readNbtFile(filePath);
            if (!nbtData || !nbtData.Players) continue;
            
            // Search through players for matching UUID
            for (const playerId in nbtData.Players) {
                const player = nbtData.Players[playerId];
                const playerUuid = (player.UUID || '').replace(/-/g, '').toLowerCase();
                
                if (playerUuid === normalizedUuid) {
                    const playerHomes = player.Homes || {};
                    for (const homeName in playerHomes) {
                        const coords = playerHomes[homeName];
                        // Format: [x, y, z, dimID] as IntArray
                        if (Array.isArray(coords) && coords.length >= 3) {
                            homes.push({
                                name: homeName,
                                x: Math.floor(coords[0]),
                                y: Math.floor(coords[1]),
                                z: Math.floor(coords[2]),
                                dimID: coords.length >= 4 ? coords[3] : 0,
                                dim: getDimNameFromId(coords.length >= 4 ? coords[3] : 0)
                            });
                        }
                    }
                    break;
                }
            }
        } catch (error) {
            // Continue to next path
        }
    }
    
    return homes;
}

/**
 * Finds homes from FTB Lib/Utilities player data (1.12 format).
 * Format: Binary NBT with Data.ftbutilities.Homes.{name} = [I; x, y, z, dimID]
 * @param {string} basePath - Server base path
 * @param {string} uuid - Player UUID
 * @returns {Promise<Array>} Array of home objects {name, x, y, z, dimID}
 */
async function findFtbLibHomes(basePath, uuid) {
    const homes = [];
    const normalizedUuid = normalizeUuid(uuid);
    const undashedUuid = uuid.replace(/-/g, '').toLowerCase();
    
    const possiblePaths = [
        path.join(basePath, 'data/ftb_lib/players'),
        path.join(basePath, 'world/data/ftb_lib/players'),
        path.join(basePath, 'World/data/ftb_lib/players'),
    ];
    
    for (const playersPath of possiblePaths) {
        if (!await fs.pathExists(playersPath)) continue;
        
        try {
            const files = await fs.readdir(playersPath);
            for (const file of files) {
                if (!file.endsWith('.dat')) continue;
                
                const filePath = path.join(playersPath, file);
                const nbtData = await readNbtFile(filePath);
                if (!nbtData) continue;
                
                // Check if this is the right player
                const playerUuid = (nbtData.UUID || '').replace(/-/g, '').toLowerCase();
                if (playerUuid !== undashedUuid) continue;
                
                // Extract homes from Data.ftbutilities.Homes
                const ftbutilities = nbtData.Data?.ftbutilities;
                if (ftbutilities && ftbutilities.Homes) {
                    for (const homeName in ftbutilities.Homes) {
                        const coords = ftbutilities.Homes[homeName];
                        // Format: [x, y, z, dimID] as IntArray
                        if (Array.isArray(coords) && coords.length >= 3) {
                            homes.push({
                                name: homeName,
                                x: Math.floor(coords[0]),
                                y: Math.floor(coords[1]),
                                z: Math.floor(coords[2]),
                                dimID: coords.length >= 4 ? coords[3] : 0,
                                dim: getDimNameFromId(coords.length >= 4 ? coords[3] : 0)
                            });
                        }
                    }
                }
                break;
            }
        } catch (error) {
            // Continue to next path
        }
    }
    
    return homes;
}

/**
 * Finds homes from MongoDB valhallamc.homes collection.
 * Format: { name, serverTag, player (Binary UUID), dimID, x, y, z }
 * @param {string} uuid - Player UUID
 * @returns {Promise<Array>} Array of home objects {name, x, y, z, dimID, server}
 */
async function findMongoHomes(uuid) {
    const homes = [];
    
    try {
        const client = await mongo.getClient();
        const { Binary } = require('mongodb');
        
        // Convert UUID to MongoDB Binary format
        const normalizedUuid = normalizeUuid(uuid);
        const base64 = uuidToMongoBase64(normalizedUuid);
        const binaryUuid = new Binary(Buffer.from(base64, 'base64'), Binary.SUBTYPE_UUID_OLD);
        
        const homesCollection = client.db('valhallamc').collection('homes');
        const cursor = homesCollection.find({ player: binaryUuid });
        
        await cursor.forEach(doc => {
            homes.push({
                name: doc.name || 'home',
                x: Math.floor(doc.x || 0),
                y: Math.floor(doc.y || 0),
                z: Math.floor(doc.z || 0),
                dimID: doc.dimID || 0,
                dim: doc.dimName || getDimNameFromId(doc.dimID || 0),
                server: doc.serverTag || 'unknown'
            });
        });
    } catch (error) {
        // MongoDB not available or query failed
    }
    
    return homes;
}

/**
 * Reads an NBT file and returns parsed data.
 * Uses mc-nbt-lib for high-performance native Node.js parsing.
 * @param {string} filePath - Path to NBT file
 * @returns {Promise<object|null>} Parsed NBT data or null
 */
async function readNbtFile(filePath) {
    if (!await fs.pathExists(filePath)) return null;
    
    try {
        // Read file as buffer first
        const buffer = await fs.readFile(filePath);
        
        // Try compressed NBT first (most .dat files are gzip-compressed)
        try {
            const data = minecraftNBT.parseCompressedNBT(buffer);
            return convertMcNbtToPlain(data);
        } catch (e) {
            // If compressed fails, try uncompressed NBT
            try {
                const data = minecraftNBT.parseNBT(buffer);
                return convertMcNbtToPlain(data);
            } catch (e2) {
                throw new Error(`Failed to parse as compressed or uncompressed NBT: ${e.message}`);
            }
        }
    } catch (e) {
        console.error(`[NBT] Failed to read ${filePath}:`, e.message);
        return null;
    }
}

/**
 * Converts mc-nbt-lib data format to plain JavaScript objects.
 * mc-nbt-lib wraps values in { type, value } objects.
 * @param {object} nbtData - NBT data object from mc-nbt-lib
 * @returns {object} Plain JavaScript object
 */
function convertMcNbtToPlain(nbtData) {
    if (nbtData === null || nbtData === undefined) return null;
    
    // Handle BigInt values (from NBT Long type)
    // Convert to Number for compatibility, or String if too large
    if (typeof nbtData === 'bigint') {
        // Convert BigInt to Number if it fits in safe integer range
        if (nbtData >= Number.MIN_SAFE_INTEGER && nbtData <= Number.MAX_SAFE_INTEGER) {
            return Number(nbtData);
        }
        // Otherwise convert to String
        return nbtData.toString();
    }
    
    // mc-nbt-lib wraps values in { type, value } objects
    if (nbtData.type !== undefined && nbtData.value !== undefined) {
        return convertMcNbtToPlain(nbtData.value);
    }
    
    if (typeof nbtData !== 'object') return nbtData;
    
    if (Array.isArray(nbtData)) {
        return nbtData.map(v => convertMcNbtToPlain(v));
    }
    
    const result = {};
    for (const [key, value] of Object.entries(nbtData)) {
        result[key] = convertMcNbtToPlain(value);
    }
    return result;
}

/**
 * Converts dimension ID to dimension name.
 * @param {number} dimID - Dimension ID
 * @returns {string} Dimension name
 */
function getDimNameFromId(dimID) {
    switch (dimID) {
        case 0: return 'minecraft:overworld';
        case -1: return 'minecraft:the_nether';
        case 1: return 'minecraft:the_end';
        default: return `dim_${dimID}`;
    }
}

/**
 * Creates a unique key for a home to use in deduplication.
 * Homes with the same name, coordinates, and dimension are considered duplicates.
 * @param {object} home - Home object with name, x, y, z, dimID
 * @returns {string} Unique key
 */
function getHomeDedupeKey(home) {
    // Round coordinates to handle floating point variations
    const x = Math.floor(home.x);
    const y = Math.floor(home.y);
    const z = Math.floor(home.z);
    const dimID = home.dimID || 0;
    return `${home.name}|${x}|${y}|${z}|${dimID}`;
}

/**
 * Collects all homes for a player from all sources.
 * Only deduplicates MongoDB homes against file-based homes (to avoid double counting).
 * File-based homes from different servers are all counted separately.
 * @param {string} uuid - Player UUID
 * @param {Array} serverFolders - Array of discovered server folders
 * @returns {Promise<object>} Object with unique_homes count and all_homes array
 */
async function collectAllHomes(uuid, serverFolders) {
    const allHomes = [];
    const fileHomeKeys = new Set(); // Track keys from file sources for MongoDB deduplication
    
    // Collect homes from file-based sources (per-server) - NO deduplication between them
    for (const { server, basePath } of serverFolders) {
        // 1. FTBEssentials (modern format)
        const essentialsData = await findFtbEssentialsData(basePath, uuid);
        if (essentialsData && essentialsData.homes) {
            for (const home of essentialsData.homes) {
                const key = getHomeDedupeKey(home);
                fileHomeKeys.add(key); // Track for MongoDB deduplication
                allHomes.push({ ...home, source: 'ftbessentials', server });
            }
        }
        
        // 2. LMPlayers.dat (legacy 1.7.10-1.12)
        const lmHomes = await findLMPlayersHomes(basePath, uuid);
        for (const home of lmHomes) {
            const key = getHomeDedupeKey(home);
            fileHomeKeys.add(key); // Track for MongoDB deduplication
            allHomes.push({ ...home, source: 'lmplayers', server });
        }
        
        // 3. FTB Lib/Utilities (1.12 format)
        const ftbLibHomes = await findFtbLibHomes(basePath, uuid);
        for (const home of ftbLibHomes) {
            const key = getHomeDedupeKey(home);
            fileHomeKeys.add(key); // Track for MongoDB deduplication
            allHomes.push({ ...home, source: 'ftblib', server });
        }
    }
    
    // 4. MongoDB homes - ONLY deduplicate against file-based homes
    const mongoHomes = await findMongoHomes(uuid);
    for (const home of mongoHomes) {
        const key = getHomeDedupeKey(home);
        // Only add if not already found in file sources
        if (!fileHomeKeys.has(key)) {
            allHomes.push({ ...home, source: 'mongodb' });
        }
    }
    
    return {
        unique_homes: allHomes.length,
        all_homes: allHomes
    };
}

/**
 * Extracts the earliest timestamp from FTBQuests SNBT data.
 * Looks at 'started', 'completed', and 'claimed_rewards' objects for epoch ms timestamps.
 * @param {string} basePath - Server base path
 * @param {string} uuid - Player UUID
 * @returns {Promise<number|null>} Earliest epoch timestamp in ms, or null
 */
async function extractFtbQuestsTimestamp(basePath, uuid) {
    const normalizedUuid = normalizeUuid(uuid);
    const undashedUuid = uuid.replace(/-/g, '');
    
    const possiblePaths = [
        path.join(basePath, 'ftbquests/player_data', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbquests/player_data', `${undashedUuid}.snbt`),
        path.join(basePath, 'ftbquests', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbquests', `${undashedUuid}.snbt`),
        path.join(basePath, 'world/ftbquests/player_data', `${normalizedUuid}.snbt`),
        path.join(basePath, 'world/ftbquests/player_data', `${undashedUuid}.snbt`),
        path.join(basePath, 'world/ftbquests', `${normalizedUuid}.snbt`),
        path.join(basePath, 'world/ftbquests', `${undashedUuid}.snbt`),
    ];
    
    for (const filePath of possiblePaths) {
        try {
            if (!await fs.pathExists(filePath)) continue;
            const content = await fs.readFile(filePath, 'utf-8');
            const data = parseSNBT(content);
            if (!data) continue;
            
            let timestamps = [];
            
            // Extract timestamps from 'started' object (e.g., "HEXID": 1730753071054)
            if (data.started && typeof data.started === 'object') {
                for (const ts of Object.values(data.started)) {
                    if (typeof ts === 'number' && ts > 1000000000000) { // Valid epoch ms
                        timestamps.push(ts);
                    }
                }
            }
            
            // Extract timestamps from 'completed' object
            if (data.completed && typeof data.completed === 'object') {
                for (const ts of Object.values(data.completed)) {
                    if (typeof ts === 'number' && ts > 1000000000000) {
                        timestamps.push(ts);
                    }
                }
            }
            
            // Extract timestamps from 'claimed_rewards' object
            if (data.claimed_rewards && typeof data.claimed_rewards === 'object') {
                for (const ts of Object.values(data.claimed_rewards)) {
                    if (typeof ts === 'number' && ts > 1000000000000) {
                        timestamps.push(ts);
                    }
                }
            }
            
            if (timestamps.length > 0) {
                return Math.min(...timestamps);
            }
        } catch (error) {
            // Continue to next path
        }
    }
    
    return null;
}

/**
 * Extracts the earliest timestamp from FTBChunks SNBT data.
 * Looks at chunk claim 'time' fields and 'last_login_time'.
 * @param {string} basePath - Server base path
 * @param {string} uuid - Player UUID
 * @returns {Promise<number|null>} Earliest epoch timestamp in ms, or null
 */
async function extractFtbChunksTimestamp(basePath, uuid) {
    const normalizedUuid = normalizeUuid(uuid);
    const undashedUuid = uuid.replace(/-/g, '');
    
    const possiblePaths = [
        path.join(basePath, 'ftbchunks/claimed', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbchunks/claimed', `${undashedUuid}.snbt`),
        path.join(basePath, 'ftbchunks', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbchunks', `${undashedUuid}.snbt`),
        path.join(basePath, 'world/ftbchunks/claimed', `${normalizedUuid}.snbt`),
        path.join(basePath, 'world/ftbchunks/claimed', `${undashedUuid}.snbt`),
        path.join(basePath, 'world/ftbchunks', `${normalizedUuid}.snbt`),
        path.join(basePath, 'world/ftbchunks', `${undashedUuid}.snbt`),
    ];
    
    for (const filePath of possiblePaths) {
        try {
            if (!await fs.pathExists(filePath)) continue;
            const content = await fs.readFile(filePath, 'utf-8');
            
            let timestamps = [];
            
            // Use regex to extract all 'time:' values from raw content
            // Format: time: 1739054925410 (snbtParser already strips the L suffix)
            const timeMatches = content.match(/time:\s*(\d{13,})/g);
            if (timeMatches) {
                for (const match of timeMatches) {
                    const ts = parseInt(match.replace(/time:\s*/, '').replace(/L$/, ''));
                    if (ts > 1000000000000) {
                        timestamps.push(ts);
                    }
                }
            }
            
            // Also check last_login_time
            const loginMatch = content.match(/last_login_time:\s*(\d+)/);
            if (loginMatch) {
                const ts = parseInt(loginMatch[1]);
                if (ts > 1000000000000) {
                    timestamps.push(ts);
                }
            }
            
            if (timestamps.length > 0) {
                return Math.min(...timestamps);
            }
        } catch (error) {
            // Continue to next path
        }
    }
    
    return null;
}

/**
 * Extracts the earliest timestamp from FTBEssentials teleport history.
 * @param {string} basePath - Server base path
 * @param {string} uuid - Player UUID
 * @returns {Promise<number|null>} Earliest epoch timestamp in ms, or null
 */
async function extractFtbEssentialsTimestamp(basePath, uuid) {
    const normalizedUuid = normalizeUuid(uuid);
    const undashedUuid = uuid.replace(/-/g, '');
    
    const possiblePaths = [
        path.join(basePath, 'ftbessentials/playerdata', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbessentials/playerdata', `${undashedUuid}.snbt`),
        path.join(basePath, 'ftbessentials', `${normalizedUuid}.snbt`),
        path.join(basePath, 'ftbessentials', `${undashedUuid}.snbt`),
    ];
    
    for (const filePath of possiblePaths) {
        try {
            if (!await fs.pathExists(filePath)) continue;
            const content = await fs.readFile(filePath, 'utf-8');
            
            let timestamps = [];
            
            // Extract all 'time:' values from teleport_history
            const timeMatches = content.match(/time:\s*(\d{13,})/g);
            if (timeMatches) {
                for (const match of timeMatches) {
                    const ts = parseInt(match.replace(/time:\s*/, '').replace(/L$/, ''));
                    if (ts > 1000000000000) {
                        timestamps.push(ts);
                    }
                }
            }
            
            if (timestamps.length > 0) {
                return Math.min(...timestamps);
            }
        } catch (error) {
            // Continue to next path
        }
    }
    
    return null;
}

/**
 * Extracts the earliest timestamp from BetterQuesting quest progress.
 * Looks for 'timestamp:4' fields in quest completion data (epoch ms).
 * @param {string} basePath - Server base path
 * @param {string} uuid - Player UUID
 * @returns {Promise<number|null>} Earliest epoch timestamp in ms, or null
 */
async function extractBetterQuestingTimestamp(basePath, uuid) {
    const normalizedUuid = normalizeUuid(uuid);
    
    const possiblePaths = [
        path.join(basePath, 'betterquesting/QuestProgress', `${normalizedUuid}.json`),
        path.join(basePath, 'world/betterquesting/QuestProgress', `${normalizedUuid}.json`),
        path.join(basePath, 'DregoraRL/betterquesting/QuestProgress', `${normalizedUuid}.json`),
        path.join(basePath, 'World/betterquesting/QuestProgress', `${normalizedUuid}.json`),
    ];
    
    for (const filePath of possiblePaths) {
        try {
            if (!await fs.pathExists(filePath)) continue;
            const content = await fs.readFile(filePath, 'utf-8');
            
            let timestamps = [];
            
            // Extract all 'timestamp:4' values (BetterQuesting format)
            // Format: "timestamp:4": 1743509820548
            const timestampMatches = content.match(/"timestamp:4":\s*(\d{13,})/g);
            if (timestampMatches) {
                for (const match of timestampMatches) {
                    const ts = parseInt(match.replace(/"timestamp:4":\s*/, ''));
                    if (ts > 1000000000000) {
                        timestamps.push(ts);
                    }
                }
            }
            
            if (timestamps.length > 0) {
                return Math.min(...timestamps);
            }
        } catch (error) {
            // Continue to next path
        }
    }
    
    return null;
}

/**
 * Aggregates all statistics for a player across all servers.
 * @param {string} uuid - Player UUID (any format)
 * @returns {Promise<object>} Complete aggregated statistics
 */
async function aggregatePlayerStats(uuid) {
    const normalizedUuid = normalizeUuid(uuid);
    const serverFolders = await discoverStatsFolders();
    
    const result = {
        uuid: normalizedUuid,
        servers: {},
        // MongoDB data
        mongo_playtime_minutes: 0,
        first_seen: null, // { date: Date, server: string, source: string }
        totals: {
            // Vanilla stats
            play_time_ticks: 0,
            deaths: 0,
            mob_kills: 0,
            player_kills: 0,
            damage_dealt: 0,
            damage_taken: 0,
            jumps: 0,
            
            // Distance (in cm, will convert later)
            walk_distance: 0,
            sprint_distance: 0,
            fly_distance: 0,
            swim_distance: 0,
            fall_distance: 0,
            climb_distance: 0,
            crouch_distance: 0,
            
            // Blocks
            blocks_mined: 0,
            blocks_placed: 0,
            
            // Items
            items_crafted: 0,
            items_used: 0,
            items_picked_up: 0,
            items_dropped: 0,
            
            // Quests
            quests_completed: 0,
            quests_started: 0,
            rewards_claimed: 0,
            
            // Chunks
            chunks_claimed: 0,
            chunks_force_loaded: 0,
            
            // Misc
            homes_set: 0,
            servers_played: 0,
            
            // New stats
            animals_bred: 0,
            fish_caught: 0,
            villager_trades: 0,
            items_enchanted: 0,
            chests_opened: 0,
            times_slept: 0,
            raiders_killed: 0,
            cake_slices: 0,
            bells_rung: 0
        },
        top_stats: {
            most_mined_block: { name: '', count: 0 },
            most_killed_mob: { name: '', count: 0 },
            most_crafted_item: { name: '', count: 0 },
            most_used_item: { name: '', count: 0 },
            top_killer: { name: '', count: 0 },
            favorite_server: { name: '', playtime: 0 }
        },
        block_counts: {},
        mob_kills: {},
        killed_by: {},
        items_crafted: {},
        items_used: {}
    };
    
    for (const { server, statsPath, basePath } of serverFolders) {
        const serverStats = {
            has_data: false,
            vanilla: null,
            quests: null,
            chunks: null,
            essentials: null,
            teams: null
        };
        
        // Read vanilla stats
        const vanillaStats = await readPlayerStats(statsPath, normalizedUuid);
        if (vanillaStats) {
            serverStats.has_data = true;
            serverStats.vanilla = vanillaStats;
            
            // Aggregate vanilla stats
            const custom = vanillaStats['minecraft:custom'] || {};
            
            result.totals.play_time_ticks += custom['minecraft:play_time'] || 0;
            result.totals.deaths += custom['minecraft:deaths'] || 0;
            result.totals.mob_kills += custom['minecraft:mob_kills'] || 0;
            result.totals.player_kills += custom['minecraft:player_kills'] || 0;
            result.totals.damage_dealt += custom['minecraft:damage_dealt'] || 0;
            result.totals.damage_taken += custom['minecraft:damage_taken'] || 0;
            result.totals.jumps += custom['minecraft:jump'] || 0;
            
            result.totals.walk_distance += custom['minecraft:walk_one_cm'] || 0;
            result.totals.sprint_distance += custom['minecraft:sprint_one_cm'] || 0;
            result.totals.fly_distance += custom['minecraft:fly_one_cm'] || 0;
            result.totals.swim_distance += custom['minecraft:swim_one_cm'] || 0;
            result.totals.fall_distance += custom['minecraft:fall_one_cm'] || 0;
            result.totals.climb_distance += custom['minecraft:climb_one_cm'] || 0;
            result.totals.crouch_distance += custom['minecraft:crouch_one_cm'] || 0;
            
            // New vanilla stats
            result.totals.animals_bred += custom['minecraft:animals_bred'] || 0;
            result.totals.fish_caught += custom['minecraft:fish_caught'] || 0;
            result.totals.villager_trades += custom['minecraft:traded_with_villager'] || 0;
            result.totals.items_enchanted += custom['minecraft:enchant_item'] || 0;
            result.totals.chests_opened += custom['minecraft:open_chest'] || 0;
            result.totals.times_slept += custom['minecraft:sleep_in_bed'] || 0;
            result.totals.raiders_killed += custom['minecraft:raid_kill'] || 0;
            result.totals.cake_slices += custom['minecraft:eat_cake_slice'] || 0;
            result.totals.bells_rung += custom['minecraft:bell_ring'] || 0;
            
            // Count blocks mined (filter out air blocks)
            const mined = vanillaStats['minecraft:mined'] || {};
            for (const [block, count] of Object.entries(mined)) {
                if (isAirItem(block) || count <= 0) continue;
                result.totals.blocks_mined += count;
                result.block_counts[block] = (result.block_counts[block] || 0) + count;
            }
            
            // Count items crafted (filter out air items)
            const crafted = vanillaStats['minecraft:crafted'] || {};
            for (const [item, count] of Object.entries(crafted)) {
                if (isAirItem(item) || count <= 0) continue;
                result.totals.items_crafted += count;
                result.items_crafted[item] = (result.items_crafted[item] || 0) + count;
            }
            
            // Count items used (filter out air items)
            const used = vanillaStats['minecraft:used'] || {};
            for (const [item, count] of Object.entries(used)) {
                if (isAirItem(item) || count <= 0) continue;
                result.totals.items_used += count;
                result.items_used[item] = (result.items_used[item] || 0) + count;
            }
            
            // Count items picked up (filter out air items)
            const pickedUp = vanillaStats['minecraft:picked_up'] || {};
            for (const [item, count] of Object.entries(pickedUp)) {
                if (isAirItem(item) || count <= 0) continue;
                result.totals.items_picked_up += count;
            }
            
            // Count items dropped (filter out air items)
            const dropped = vanillaStats['minecraft:dropped'] || {};
            for (const [item, count] of Object.entries(dropped)) {
                if (isAirItem(item) || count <= 0) continue;
                result.totals.items_dropped += count;
            }
            
            // Count mob kills
            const killed = vanillaStats['minecraft:killed'] || {};
            for (const [mob, count] of Object.entries(killed)) {
                result.mob_kills[mob] = (result.mob_kills[mob] || 0) + count;
            }
            
            // Count deaths by
            const killedBy = vanillaStats['minecraft:killed_by'] || {};
            for (const [mob, count] of Object.entries(killedBy)) {
                result.killed_by[mob] = (result.killed_by[mob] || 0) + count;
            }
            
            // Track favorite server
            const playtime = custom['minecraft:play_time'] || 0;
            if (playtime > result.top_stats.favorite_server.playtime) {
                result.top_stats.favorite_server = { name: server, playtime };
            }
            
            // Track earliest file timestamp for first_seen
            try {
                const statsFilePath = path.join(statsPath, `${normalizedUuid}.json`);
                const fileStat = await fs.stat(statsFilePath);
                // Use mtime (modification time) as it's more reliable than birthtime on Linux
                const fileDate = fileStat.mtime;
                if (!result.first_seen || fileDate < result.first_seen.date) {
                    result.first_seen = { date: fileDate, server: server, source: 'file_mtime' };
                }
            } catch (e) {
                // Ignore stat errors
            }
            
            // Extract embedded timestamps from FTBQuests (quest start times)
            const questTimestamp = await extractFtbQuestsTimestamp(basePath, normalizedUuid);
            if (questTimestamp) {
                const questDate = new Date(questTimestamp);
                if (!result.first_seen || questDate < result.first_seen.date) {
                    result.first_seen = { date: questDate, server: server, source: 'ftbquests' };
                }
            }
            
            // Extract embedded timestamps from FTBChunks (chunk claim times)
            const chunkTimestamp = await extractFtbChunksTimestamp(basePath, normalizedUuid);
            if (chunkTimestamp) {
                const chunkDate = new Date(chunkTimestamp);
                if (!result.first_seen || chunkDate < result.first_seen.date) {
                    result.first_seen = { date: chunkDate, server: server, source: 'ftbchunks' };
                }
            }
            
            // Extract embedded timestamps from FTBEssentials (teleport history)
            const essentialsTimestamp = await extractFtbEssentialsTimestamp(basePath, normalizedUuid);
            if (essentialsTimestamp) {
                const essentialsDate = new Date(essentialsTimestamp);
                if (!result.first_seen || essentialsDate < result.first_seen.date) {
                    result.first_seen = { date: essentialsDate, server: server, source: 'ftbessentials' };
                }
            }
            
            // Extract embedded timestamps from BetterQuesting (quest completion timestamps)
            const bqTimestamp = await extractBetterQuestingTimestamp(basePath, normalizedUuid);
            if (bqTimestamp) {
                const bqDate = new Date(bqTimestamp);
                if (!result.first_seen || bqDate < result.first_seen.date) {
                    result.first_seen = { date: bqDate, server: server, source: 'betterquesting' };
                }
            }
        }
        
        // Read quest data (try FTBQuests first, then BetterQuesting)
        let questData = await findFtbQuestsData(basePath, normalizedUuid);
        if (!questData) {
            questData = await findBetterQuestingData(basePath, normalizedUuid);
        }
        if (questData) {
            serverStats.has_data = true;
            serverStats.quests = questData;
            result.totals.quests_completed += questData.completed || 0;
            result.totals.quests_started += questData.started || 0;
            result.totals.rewards_claimed += questData.claimed_rewards || 0;
        }
        
        // Read chunk data (try FTBChunks first, then LatMod)
        let chunkData = await findFtbChunksData(basePath, normalizedUuid);
        if (!chunkData) {
            chunkData = await findLatModChunksData(basePath, normalizedUuid);
        }
        if (chunkData) {
            serverStats.has_data = true;
            serverStats.chunks = chunkData;
            result.totals.chunks_claimed += chunkData.claimed || 0;
            result.totals.chunks_force_loaded += chunkData.force_loaded || 0;
        }
        
        // Read essentials data
        const essentialsData = await findFtbEssentialsData(basePath, normalizedUuid);
        if (essentialsData) {
            serverStats.has_data = true;
            serverStats.essentials = essentialsData;
            // Note: homes_set will be calculated separately with deduplication
        }
        
        // Read teams data
        const teamsData = await findFtbTeamsData(basePath, normalizedUuid);
        if (teamsData) {
            serverStats.has_data = true;
            serverStats.teams = teamsData;
        }
        
        if (serverStats.has_data) {
            result.servers[server] = serverStats;
            result.totals.servers_played++;
        }
    }
    
    // Collect and deduplicate homes from all sources
    // This is done after the server loop to collect from all sources at once
    const homesData = await collectAllHomes(normalizedUuid, serverFolders);
    result.totals.homes_set = homesData.unique_homes;
    result.all_homes = homesData.all_homes;
    
    // Calculate top stats
    for (const [block, count] of Object.entries(result.block_counts)) {
        if (isAirItem(block)) continue; // Safety check for air blocks
        if (count > result.top_stats.most_mined_block.count) {
            result.top_stats.most_mined_block = { name: getItemDisplayName(block), count, id: block };
        }
    }
    
    for (const [mob, count] of Object.entries(result.mob_kills)) {
        if (count > result.top_stats.most_killed_mob.count) {
            result.top_stats.most_killed_mob = { name: formatItemName(mob), count, id: mob };
        }
    }
    
    for (const [mob, count] of Object.entries(result.killed_by)) {
        if (count > result.top_stats.top_killer.count) {
            result.top_stats.top_killer = { name: formatItemName(mob), count, id: mob };
        }
    }
    
    for (const [item, count] of Object.entries(result.items_crafted)) {
        if (isAirItem(item)) continue; // Filter out air items
        if (count > result.top_stats.most_crafted_item.count) {
            result.top_stats.most_crafted_item = { name: getItemDisplayName(item), count, id: item };
        }
    }
    
    for (const [item, count] of Object.entries(result.items_used)) {
        if (isAirItem(item)) continue; // Filter out air items
        if (count > result.top_stats.most_used_item.count) {
            result.top_stats.most_used_item = { name: getItemDisplayName(item), count, id: item };
        }
    }
    
    // Fetch MongoDB data for playtime correction and first seen
    try {
        const playerDoc = await mongo.getPlayerByUuid(normalizedUuid);
        if (playerDoc) {
            // Sum all server playtimes from MongoDB (stored in minutes)
            if (playerDoc.playtime && typeof playerDoc.playtime === 'object') {
                let totalMongoMinutes = 0;
                for (const minutes of Object.values(playerDoc.playtime)) {
                    if (typeof minutes === 'number') {
                        totalMongoMinutes += minutes;
                    }
                }
                result.mongo_playtime_minutes = totalMongoMinutes;
                
                // Apply playtime correction formula:
                // final = mongoPlaytime + (calculatedPlaytime - mongoPlaytime) * 0.25
                const mongoTicks = totalMongoMinutes * 60 * 20; // minutes -> ticks
                const calculatedTicks = result.totals.play_time_ticks;
                result.totals.play_time_ticks = Math.floor(mongoTicks + (calculatedTicks - mongoTicks) * 0.25);
            }
            
            // Find earliest join date from first_seen and leave_dates
            let earliestDate = null;
            let earliestServer = null;
            
            // Check first_seen object
            if (playerDoc.first_seen && typeof playerDoc.first_seen === 'object') {
                for (const [server, dateObj] of Object.entries(playerDoc.first_seen)) {
                    const date = dateObj instanceof Date ? dateObj : new Date(dateObj);
                    if (!isNaN(date.getTime()) && (!earliestDate || date < earliestDate)) {
                        earliestDate = date;
                        earliestServer = server;
                    }
                }
            }
            
            // Also check leave_dates as they might have earlier dates
            if (playerDoc.leave_dates && typeof playerDoc.leave_dates === 'object') {
                for (const [server, dateObj] of Object.entries(playerDoc.leave_dates)) {
                    const date = dateObj instanceof Date ? dateObj : new Date(dateObj);
                    if (!isNaN(date.getTime()) && (!earliestDate || date < earliestDate)) {
                        earliestDate = date;
                        earliestServer = server;
                    }
                }
            }
            
            if (earliestDate && earliestServer) {
                // Only use MongoDB date if it's earlier than embedded timestamps
                if (!result.first_seen || earliestDate < result.first_seen.date) {
                    result.first_seen = { date: earliestDate, server: earliestServer, source: 'mongodb' };
                }
            }
        }
    } catch (error) {
        console.error('[Wrapped] Failed to fetch MongoDB player data:', error.message);
    }
    
    return result;
}

/**
 * Finds a player's UUID by scanning name caches in BetterQuesting.
 * @param {string} username - Player username to search
 * @returns {Promise<string|null>} UUID if found
 */
async function findUuidByUsername(username) {
    const serverDirs = await fs.readdir(STATS_BASE_PATH);
    const lowerUsername = username.toLowerCase();
    
    for (const serverDir of serverDirs) {
        const possiblePaths = [
            path.join(STATS_BASE_PATH, serverDir, 'betterquesting/NameCache.json'),
            path.join(STATS_BASE_PATH, serverDir, 'world/betterquesting/NameCache.json'),
            path.join(STATS_BASE_PATH, serverDir, 'DregoraRL/betterquesting/NameCache.json'),
        ];
        
        for (const cachePath of possiblePaths) {
            if (!await fs.pathExists(cachePath)) continue;
            
            try {
                const data = await fs.readJson(cachePath);
                const nameCache = data['nameCache:9'];
                if (nameCache) {
                    for (const key in nameCache) {
                        const entry = nameCache[key];
                        if (entry['name:8'] && entry['name:8'].toLowerCase() === lowerUsername) {
                            return entry['uuid:8'];
                        }
                    }
                }
            } catch (error) {
                continue;
            }
        }
    }
    
    return null;
}

module.exports = {
    discoverStatsFolders,
    readPlayerStats,
    aggregatePlayerStats,
    findFtbQuestsData,
    findBetterQuestingData,
    findFtbChunksData,
    findLatModChunksData,
    findFtbEssentialsData,
    findFtbTeamsData,
    findLMPlayersHomes,
    findFtbLibHomes,
    findMongoHomes,
    collectAllHomes,
    findUuidByUsername,
    extractFtbQuestsTimestamp,
    extractFtbChunksTimestamp,
    extractFtbEssentialsTimestamp,
    extractBetterQuestingTimestamp,
    convertLegacyStats,
    convertLegacyId,
    getItemDisplayName,
    formatItemName,
    STATS_BASE_PATH
};
