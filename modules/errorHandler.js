/*
 * File: errorHandler.js
 * Project: valhalla-updater
 * File Created: Thursday, 30th May 2024 11:29:57 pm
 * Author: flaasz
 * -----
 * Last Modified: Friday, 31st May 2024 4:47:44 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

// Initialize session logger for full session tracking
const sessionLogger = require('./sessionLogger');

let exitOnError = true;

// Try to load exitOnError config, but don't crash if config is broken
try {
    exitOnError = require('../config/config.json').base.exitOnError;
} catch (err) {
    console.warn('Could not load exitOnError config, defaulting to true');
}

// Enhanced error handler that preserves original functionality but with better reporting
function handleError(error, type = 'Unknown') {
    try {
        sessionLogger.fatal('ErrorHandler', `${type}: ${error.message}`);
    } catch (logErr) {
        // Session logger failed, but crash reporter will still work
    }

    // Preserve original exitOnError behavior
    if (!exitOnError) {
        console.error(`Error occurred! Check crash-logs directory for detailed report.`);
        return;
    }
    
    process.exit(1);
}

// Set up our handlers
process.on('uncaughtException', (error) => {
    console.error('\n!!! UNCAUGHT EXCEPTION !!!');
    handleError(error, 'Uncaught Exception');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\n!!! UNHANDLED PROMISE REJECTION !!!');
    const error = reason instanceof Error ? reason : new Error(String(reason));
    error.promise = promise;
    handleError(error, 'Unhandled Rejection');
});

// Start session logging
sessionLogger.logSessionStart();