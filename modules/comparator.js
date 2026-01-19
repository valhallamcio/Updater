/*
 * File: comparator.js
 * Project: valhalla-updater
 * File Created: Friday, 10th May 2024 7:42:12 pm
 * Author: flaasz
 * -----
 * Last Modified: Wednesday, 29th May 2024 2:01:34 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const dircompare = require('dir-compare');
const sessionLogger = require('./sessionLogger');

const options = {
    compareContent: true,
    comparesize: true,
    excludeFilter: ""
};
// Multiple compare strategy can be used simultaneously - compareSize, compareContent, compareDate, compareSymlink.
// If one comparison fails for a pair of files, they are considered distinct.


module.exports = {
    /**
     * Compares two directories and returns a list of changes.
     * @param {string} firstDir Path to the first directory to compare.
     * @param {string} secondDir Path to the second directory to compare.
     * @returns Object containing lists of deletions and additions.
     */
    compare: async function (firstDir, secondDir) {
        const res = await dircompare.compareSync(firstDir, secondDir, options);

        let changeList = {
            deletions: [],
            additions: [],
        };
        res.diffSet.forEach(dif => {
            if (dif.state === "left") {
                sessionLogger.debug('Comparator', `Difference - delete: ${dif.relativePath}, name1: ${dif.name1}, type1: ${dif.type1}, state: ${dif.state}`);
                changeList.deletions.push(dif.relativePath + "/" + dif.name1);
            } else if (dif.state === "right") {
                sessionLogger.debug('Comparator', `Difference - add: ${dif.relativePath}, name2: ${dif.name2}, type2: ${dif.type2}, state: ${dif.state}`);
                changeList.additions.push(dif.relativePath + "/" + dif.name2);
            } else if (dif.state === "equal") {} else {
                sessionLogger.debug('Comparator', `Difference - replace: ${dif.relativePath}, name1: ${dif.name1}, type1: ${dif.type1}, name2: ${dif.name2}, type2: ${dif.type2}, state: ${dif.state}`);
                changeList.deletions.push(dif.relativePath + "/" + dif.name1);
                changeList.additions.push(dif.relativePath + "/" + dif.name2);
            }

        });

        print(res);
        //console.log(changeList);
        return changeList;
    },

    /**
     * Finds the custom changes between two directories.
     * @param {string} customDir Path to customised directory.
     * @param {string} originalDir Path to original directory.
     * @returns Object containing lists of custom files, missing files, and edited files.
     */
    findCustomChanges: async function (customDir, originalDir) {
        const res = await dircompare.compareSync(customDir, originalDir, options);

        let customChanges = {
            customFiles: [],
            missingFiles: [],
            editedFiles: []
        };
        res.diffSet.forEach(dif => {
            if (dif.state === "left") {
                sessionLogger.debug('Comparator', `Custom file: ${dif.relativePath}, name1: ${dif.name1}, type1: ${dif.type1}, state: ${dif.state}`);
                customChanges.customFiles.push(dif.relativePath + "/" + dif.name1);
            } else if (dif.state === "right") {
                sessionLogger.debug('Comparator', `Missing file: ${dif.relativePath}, name2: ${dif.name2}, type2: ${dif.type2}, state: ${dif.state}`);
                customChanges.missingFiles.push(dif.relativePath + "/" + dif.name2);
            } else if (dif.state === "equal") {} else {
                sessionLogger.debug('Comparator', `Custom file - edited: ${dif.relativePath}, name1: ${dif.name1}, type1: ${dif.type1}, name2: ${dif.name2}, type2: ${dif.type2}, state: ${dif.state}`);
                customChanges.editedFiles.push(dif.relativePath + "/" + dif.name2);
            }

        });

        print(res);
        //console.log(changeList);
        return customChanges;
    },

    /**
     * Finds custom changes between two manifest files.
     * @param {Array} customManifest Manifest with custom changes.
     * @param {Array} originalManifest Manifest with original changes.
     * @returns Object containing lists of custom files, missing files, and edited files.
     */
    findCustomManifestChanges: async function (customManifest, originalManifest) {
        let customChanges = {
            customFiles: [],
            missingFiles: [],
            editedFiles: []
        };

        let changelog = await this.compareManifest(customManifest, originalManifest);

        changelog.leftOnly.forEach(dif => {
            sessionLogger.debug('Comparator', `Custom file: ${dif.path}, name1: ${dif.name}`);
            customChanges.customFiles.push(dif.path + dif.name);
        });

        changelog.rightOnly.forEach(dif => {
            sessionLogger.debug('Comparator', `Missing file: ${dif.path}, name2: ${dif.name}`);
            customChanges.missingFiles.push(dif.path + dif.name);
        });

        changelog.different.forEach(dif => {
            sessionLogger.debug('Comparator', `Custom file - edited: ${dif.left.path}, name1: ${dif.left.name}, name2: ${dif.right.name}`);
            customChanges.editedFiles.push(dif.left.path + dif.left.name);
        });
        sessionLogger.debug('Comparator', 'Custom changes found:', customChanges);
        return customChanges;
    },

    /**
     * Finds the changes between two manifest files.
     * @param {Array} customManifest Manifest with custom changes.
     * @param {Array} originalManifest Manifest with original changes.
     * @returns Object containing lists of deletions and additions.
     */
    findManifestChanges: async function (customManifest, originalManifest) {
        let changeList = {
            deletions: [],
            additions: [],
        };

        let changelog = await this.compareManifest(customManifest, originalManifest);

        // Helper function to normalize paths (ensure trailing slash)
        const normalizePath = (path) => path.endsWith('/') ? path : path + '/';

        changelog.leftOnly.forEach(dif => {
            sessionLogger.debug('Comparator', `Difference - delete: ${dif.path}, name1: ${dif.name}`);
            changeList.deletions.push(normalizePath(dif.path) + dif.name);
        });

        changelog.rightOnly.forEach(dif => {
            sessionLogger.debug('Comparator', `Difference - add: ${dif.path}, name2: ${dif.name}`);
            changeList.additions.push(normalizePath(dif.path) + dif.name);
        });

        changelog.different.forEach(dif => {
            sessionLogger.debug('Comparator', `Difference - replace: ${dif.left.path}, name1: ${dif.left.name}, name2: ${dif.right.name}`);
            changeList.deletions.push(normalizePath(dif.left.path) + dif.left.name);
            changeList.additions.push(normalizePath(dif.right.path) + dif.right.name);
        });

        // Diagnostic logging for manifest changes
        sessionLogger.info('Comparator', `Found ${changeList.deletions.length} deletions and ${changeList.additions.length} additions`);
        if (changeList.additions.length > 0) {
            sessionLogger.info('Comparator', `First 3 additions: ${JSON.stringify(changeList.additions.slice(0, 3))}`);
        }

        return changeList;
    },


    /**
     * Compare two manifest files and return the differences.
     * @param {Array} leftManifest First manifest to compare.
     * @param {Array} rightManifest Second manifest to compare.
     * @returns Object containing lists of matching, left only, right only, and different files.
     */
    compareManifest: async function (leftManifest, rightManifest) {
        let result = {
            matching: [],
            leftOnly: [],
            rightOnly: [],
            different: []
        };

        let leftMap = new Map();
        let rightMap = new Map();

        leftManifest.forEach(item => {
            const key = `${item.path}:${item.name}`;
            leftMap.set(key, item);
        });

        rightManifest.forEach(item => {
            const key = `${item.path}:${item.name}`;
            rightMap.set(key, item);
        });

        leftMap.forEach((leftItem, key) => {
            if (rightMap.has(key)) {
                const rightItem = rightMap.get(key);
                if (leftItem.sha1 === rightItem.sha1 && leftItem.size === rightItem.size) {
                    result.matching.push(leftItem);
                } else {
                    result.different.push({
                        left: leftItem,
                        right: rightItem
                    });
                }
                rightMap.delete(key);
            } else {
                result.leftOnly.push(leftItem);
            }
        });

        rightMap.forEach(rightItem => {
            result.rightOnly.push(rightItem);
        });

        return result;
    }

};

/**
 * Parses the result of the comparison and prints it to the console.
 * @param {object} result Result of the comparison.
 */
function print(result) {
    sessionLogger.debug('Comparator', `Directories are ${result.same ? 'identical' : 'different'}`);

    sessionLogger.debug('Comparator', `Statistics - equal entries: ${result.equal}, distinct entries: ${result.distinct}, left only entries: ${result.left}, right only entries: ${result.right}, differences: ${result.differences}`);

    //result.diffSet.forEach(dif => console.log('Difference - path: %s, name1: %s, type1: %s, name2: %s, type2: %s, state: %s',
    //dif.relativePath, dif.name1, dif.type1, dif.name2, dif.type2, dif.state));
}