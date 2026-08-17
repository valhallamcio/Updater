/*
 * File: functions.js
 * Project: valhalla-updater
 * File Created: Saturday, 11th May 2024 4:13:53 pm
 * Author: flaasz
 * -----
 * Last Modified: Saturday, 1st June 2024 11:10:19 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const sessionLogger = require('./sessionLogger');


module.exports = {    /**
     * Checks if the mods folder exists in the specified path.
     * If 'overrides' folder exists, assume it contains the actual modpack content.
     * @param {string} path Path to the folder to check.
     */
    checkMods: async function (path) {
        let folderContents = await fs.readdirSync(path);
        
        // Check for a server files directory (like Server-Files-X.X.X)
        const serverDirRegex = /^Server-Files|^server-files|^ServerPack|^serverpack/;
        const serverDirs = folderContents.filter(item => {
            const itemPath = `${path}/${item}`;
            return fs.existsSync(itemPath) && 
                   fs.lstatSync(itemPath).isDirectory() && 
                   (serverDirRegex.test(item) || item.toLowerCase().includes('server'));
        });
        
        // If we found a likely server files container directory
        if (serverDirs.length === 1) {
            sessionLogger.info('Functions', `Found server pack directory: ${serverDirs[0]}. Moving contents to parent directory...`);
            const serverDir = serverDirs[0];
            const serverPath = `${path}/${serverDir}`;
            const serverContents = await fs.readdirSync(serverPath);
            
            // Move all contents from server dir to parent directory
            for (const item of serverContents) {
                const sourcePath = `${serverPath}/${item}`;
                const destPath = `${path}/${item}`;
                
                // Skip if destination already exists
                if (!fs.existsSync(destPath)) {
                    if (fs.lstatSync(sourcePath).isDirectory()) {
                        await fs.copy(sourcePath, destPath);
                    } else {
                        await fs.copyFile(sourcePath, destPath);
                    }
                }
            }
            
            // Remove the now-unnecessary server directory to avoid duplication
            await fs.remove(`${path}/${serverDir}`);
            sessionLogger.info('Functions', `Moved server files and removed container directory`);
            
            // Update folder contents for next checks
            folderContents = await fs.readdirSync(path);
        }
        
        // First check if there's an overrides folder
        if (folderContents.includes("overrides")) {
            sessionLogger.info('Functions', "Found 'overrides' folder. Moving contents to parent directory...");
            const overridesPath = `${path}/overrides`;
            const overrideContents = await fs.readdirSync(overridesPath);
            
            // Copy all contents from overrides to parent directory
            for (const item of overrideContents) {
                const sourcePath = `${overridesPath}/${item}`;
                const destPath = `${path}/${item}`;
                
                // Skip if destination already exists
                if (!fs.existsSync(destPath)) {
                    if (fs.lstatSync(sourcePath).isDirectory()) {
                        await fs.copy(sourcePath, destPath);
                    } else {
                        await fs.copyFile(sourcePath, destPath);
                    }
                }
            }
            
            // Now check if mods were moved
            folderContents = await fs.readdirSync(path);
            if (!folderContents.includes("mods")) {
                sessionLogger.warn('Functions', "Mods folder not found even after processing overrides!");
            }
        } else if (!folderContents.includes("mods")) {
            // Try to find the directory containing mods
            const potentialDirectories = folderContents.filter(item => {
                const itemPath = `${path}/${item}`;
                return fs.existsSync(itemPath) && fs.lstatSync(itemPath).isDirectory();
            });
            
            if (potentialDirectories.length > 0) {
                // Check each directory for a mods folder
                for (const dir of potentialDirectories) {
                    const dirPath = `${path}/${dir}`;
                    const dirContents = await fs.readdirSync(dirPath);
                    
                    if (dirContents.includes("mods")) {
                        sessionLogger.info('Functions', `Found mods folder inside ${dir}. Moving contents to parent directory...`);
                        try {
                            for (const item of dirContents) {
                                const sourcePath = `${dirPath}/${item}`;
                                const destPath = `${path}/${item}`;
                                
                                if (!fs.existsSync(destPath)) {
                                    if (fs.lstatSync(sourcePath).isDirectory()) {
                                        await fs.copy(sourcePath, destPath);
                                    } else {
                                        await fs.copyFile(sourcePath, destPath);
                                    }
                                }
                            }
                            break;
                        } catch (error) {
                            sessionLogger.error('Functions', `Error moving contents from ${dir}:`, error);
                        }
                    }
                }
            } else {
                sessionLogger.warn('Functions', "Mods folder not found and no suitable directories to check!");
            }
        }
    },

    /**
     * Recursively deletes the specified directory if it exists.
     * @param {*} dirPath Path to the directory to delete.
     */
    rmRecursive: function (dirPath) {
        if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, {
                recursive: true,
                force: true
            });
        }
    },

    /**
     * Sleeps for the specified amount of time.
     * @param {number} ms Time in milliseconds.
     * @returns Promise that resolves after the specified time.
     */
    sleep: function (ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    /**
     * Hashes a file using the SHA1 algorithm.
     * @param {string} filePath Path to the file to hash.
     * @returns Hash of the file as a string.
     */
    hashFile: function (filePath) {
        const file = fs.readFileSync(filePath);
        let hash = crypto.createHash('sha1').update(file).digest('hex');
        return hash;
    },

    /**
     * Moves all files out of a folder and removes the folder.
     * @param {string} folderPath Path to the folder to remove.
     */
    removeParentFolder: async function (folderPath) {
        try {
            const parentDir = await fs.readdir(folderPath);
            // Move all files and folders to the relative parent directory
            for (const file of parentDir) {
                const fullPath = path.join(folderPath, file);
                const destPath = path.join(path.dirname(folderPath), file);
                await fs.move(fullPath, destPath, {
                    overwrite: true
                });
            }
            // Remove the now empty parent folder
            await fs.rmdir(folderPath);
            sessionLogger.info('Functions', `Parent folder '${folderPath}' removed successfully`);
        } catch (err) {
            sessionLogger.error('Functions', `Error removing parent folder '${folderPath}':`, err);
        }
    },

    /**
     * Clears console output by moving the cursor up by the specified amount and clearing the screen down.
     * @param {number} amount Number of lines to move the cursor up by.
     */
    clearConsole: function (amount) {
        process.stdout.moveCursor(0, -amount);
        process.stdout.clearScreenDown();
    },

    /**
     * Gets the version number from a string.
     * @param {string} versionString The string to extract the version number from.
     * @returns The version number as a string.
     */
    getVersion: function (versionString) {

        const versionRegex = /(\bv\d+[a-zA-Z]*\b|v\d+[a-zA-Z]*|\d+\.\d+\.\d+([a-zA-Z_]\w*)?|\d+\.\d+([a-zA-Z_]\w*)?)($|\s|\.zip)/g;

        if (typeof versionString !== 'string') return null;

        let version = versionString.match(versionRegex);
        return version ? version[0].trim().replace(/\.zip$|v/g, '') : null;
    },

    /**
     * Calculates the size of all files in the specified directory.
     * @param {string} dir A directory to calculate the size of.
     * @returns Size of all files in the directory in bytes.
     */
    calculateTotalSize: function (dir) {
        let totalSize = 0;
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const filePath = path.join(dir, file);
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) {
                totalSize += module.exports.calculateTotalSize(filePath);
            } else {
                totalSize += stats.size;
            }
        });
        return totalSize;
    },

    /**
     * Counts the number of files in a directory and its subdirectories.
     * @param {string} dir Path to the directory to count files in.
     * @returns Number of files in the directory.
     */
    countFiles: function (dir) {
        let count = 0;

        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const filePath = path.join(dir, file);
            const stats = fs.statSync(filePath);
            if (stats.isFile()) {
                count++;
            } else if (stats.isDirectory()) {
                count += module.exports.countFiles(filePath);
            }
        });

        return count;
    }
};
