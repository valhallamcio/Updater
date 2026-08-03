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

const fs = require('fs');
const path = require('path');

// Ensure crash-logs exists up front so both the JS handler and V8's fatal-error report (which
// runs outside JS and may not create the dir) have somewhere to write.
try {
    fs.mkdirSync(path.join(process.cwd(), 'crash-logs'), { recursive: true });
} catch (err) {
    console.warn('Could not create crash-logs directory:', err.message);
}

// Initialize session logger for full session tracking
const sessionLogger = require('./sessionLogger');

let exitOnError = true;

// Try to load exitOnError config, but don't crash if config is broken
try {
    exitOnError = require('../config/config.json').base.exitOnError;
} catch (err) {
    console.warn('Could not load exitOnError config, defaulting to true');
}

/**
 * Write a rich crash report to crash-logs/ before we die. The in-memory log buffer is NOT flushed
 * to latest.log on an abrupt exit, so a crash would leave no trace (observed 2026-08-03: the
 * updater died mid-reboot with nothing in the log). Sync write guarantees the file exists.
 */
function writeCrashReport(error, type) {
    let file = null;
    try {
        const dir = path.join(process.cwd(), 'crash-logs');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        file = path.join(dir, `crash-${stamp}.json`);
        const report = {
            timestamp: new Date().toISOString(),
            type,
            message: error && error.message ? error.message : String(error),
            stack: error && error.stack ? error.stack : undefined,
            ...sessionLogger.getSessionInfo(),
            recentLogs: sessionLogger.getRecentLogs(200)
        };
        fs.writeFileSync(file, JSON.stringify(report, null, 2));
    } catch (err) {
        // Never let crash reporting itself crash the crash handler
        try { console.error('Could not write crash report:', err.message); } catch { /* ignore */ }
        file = null;
    }
    return file;
}

// Enhanced error handler that preserves original functionality but with better reporting
function handleError(error, type = 'Unknown') {
    const reportFile = writeCrashReport(error, type);

    try {
        sessionLogger.fatal('ErrorHandler', `${type}: ${error.message}${reportFile ? ` — crash report: ${reportFile}` : ''}`);
    } catch (logErr) {
        // Session logger failed, but the crash report was already written
    }

    // Preserve original exitOnError behavior
    if (!exitOnError) {
        console.error(`Error occurred! ${reportFile ? `Crash report saved to ${reportFile}` : 'Check crash-logs directory for detailed report.'}`);
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