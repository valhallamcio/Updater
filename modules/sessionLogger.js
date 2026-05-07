const fs = require('fs');
const path = require('path');
const moment = require('moment');

class CircularBuffer {
    constructor(size) {
        this.size = size;
        this.buffer = new Array(size);
        this.index = 0;
        this.count = 0;
    }

    add(item) {
        this.buffer[this.index] = item;
        this.index = (this.index + 1) % this.size;
        if (this.count < this.size) this.count++;
    }

    getAll() {
        if (this.count === 0) return [];
        
        const result = [];
        let startIndex = this.count < this.size ? 0 : this.index;
        
        for (let i = 0; i < this.count; i++) {
            result.push(this.buffer[(startIndex + i) % this.size]);
        }
        
        return result;
    }

    getLast(n) {
        const all = this.getAll();
        return all.slice(-n);
    }
}

class SessionLogger {
    constructor() {
        this.logBuffer = new CircularBuffer(1000);
        this.writeQueue = [];
        this.isWriting = false;
        this.sessionStartTime = new Date();
        this.logLevel = 'INFO';
        this.logLevels = {
            'DEBUG': 0,
            'INFO': 1,
            'WARN': 2,
            'ERROR': 3,
            'FATAL': 4
        };
        this.memorySnapshots = [];
        
        this.setupLogDirectory();
        this.rotateLogFile();
        this.startWriteProcessor();
        this.setupPerformanceMonitoring();
        this.setupLogRetention();
    }

    setupLogDirectory() {
        const logsDir = path.join(process.cwd(), 'logs');
        try {
            if (!fs.existsSync(logsDir)) {
                fs.mkdirSync(logsDir, { recursive: true });
            }
        } catch (err) {
            // Fallback: try creating in current directory
            console.error(`Could not create logs directory: ${err.message}`);
        }
    }

    rotateLogFile() {
        const logsDir = path.join(process.cwd(), 'logs');
        const latestLogPath = path.join(logsDir, 'latest.log');
        
        try {
            if (fs.existsSync(latestLogPath)) {
                const stats = fs.statSync(latestLogPath);
                const date = moment(stats.mtime).format('YYYY-MM-DD');
                
                // Find next available session number for today
                let sessionNum = 1;
                let archivedPath;
                do {
                    archivedPath = path.join(logsDir, `${date}-${sessionNum}.log`);
                    sessionNum++;
                } while (fs.existsSync(archivedPath));
                
                // Move latest.log to archived name
                fs.renameSync(latestLogPath, archivedPath);
                
                // Try to compress the archived log
                this.compressLogFile(archivedPath);
            }
        } catch (err) {
            console.error(`Log rotation failed: ${err.message}`);
        }
    }

    compressLogFile(filePath) {
        try {
            const zlib = require('zlib');
            const input = fs.createReadStream(filePath);
            const output = fs.createWriteStream(`${filePath}.gz`);
            const gzip = zlib.createGzip();
            
            output.on('finish', () => {
                // Delete original after compression completes
                try {
                    fs.unlinkSync(filePath);
                } catch (deleteErr) {
                    console.error(`Could not delete original log file: ${deleteErr.message}`);
                }
            });
            
            input.on('error', (err) => {
                console.error(`Log compression read error: ${err.message}`);
            });
            
            output.on('error', (err) => {
                console.error(`Log compression write error: ${err.message}`);
            });
            
            gzip.on('error', (err) => {
                console.error(`Log compression failed: ${err.message}`);
            });
            
            input.pipe(gzip).pipe(output);
            
        } catch (err) {
            // Compression failed, keep uncompressed file
            console.error(`Log compression failed: ${err.message}`);
        }
    }

    formatLogEntry(level, source, message, ...args) {
        const timestamp = moment().format('HH:mm:ss');
        const formattedArgs = args.length > 0 ? ' ' + args.map(arg => {
            if (arg instanceof Error) return `${arg.message}\n${arg.stack}`;
            if (typeof arg === 'object') return JSON.stringify(arg);
            return String(arg);
        }).join(' ') : '';
        
        return `[${timestamp}] [${source}/${level}]: ${message}${formattedArgs}`;
    }

    shouldLog(level) {
        return this.logLevels[level] >= this.logLevels[this.logLevel];
    }

    log(level, source, message, ...args) {
        if (!this.shouldLog(level)) return;
        
        const logEntry = this.formatLogEntry(level, source, message, ...args);
        
        // Always add to in-memory buffer (this never fails)
        this.logBuffer.add({
            timestamp: new Date(),
            level,
            source,
            message,
            args,
            formatted: logEntry
        });
        
        // Queue for file writing (async, non-blocking)
        this.writeQueue.push(logEntry + '\n');
        
        // Also output to console for immediate visibility
        if (level === 'ERROR' || level === 'FATAL') {
            console.error(logEntry);
        } else if (level === 'WARN') {
            console.warn(logEntry);
        } else {
            console.log(logEntry);
        }
    }

    debug(source, message, ...args) { this.log('DEBUG', source, message, ...args); }
    info(source, message, ...args) { this.log('INFO', source, message, ...args); }
    warn(source, message, ...args) { this.log('WARN', source, message, ...args); }
    error(source, message, ...args) { this.log('ERROR', source, message, ...args); }
    fatal(source, message, ...args) { this.log('FATAL', source, message, ...args); }

    startWriteProcessor() {
        setInterval(() => {
            if (this.writeQueue.length > 0 && !this.isWriting) {
                this.processWriteQueue();
            }
        }, 100); // Process queue every 100ms
    }

    processWriteQueue() {
        if (this.isWriting || this.writeQueue.length === 0) return;
        
        this.isWriting = true;
        const entries = this.writeQueue.splice(0, 100); // Process up to 100 entries at once
        const data = entries.join('');
        
        this.writeToFile(data).finally(() => {
            this.isWriting = false;
        });
    }

    async writeToFile(data) {
        const writeLocations = [
            path.join(process.cwd(), 'logs', 'latest.log'),
            path.join(process.cwd(), 'latest.log'),
            path.join('/tmp', 'valhalla-latest.log'),
            path.join(process.env.HOME || '/tmp', 'valhalla-latest.log')
        ];

        for (const location of writeLocations) {
            try {
                await fs.promises.appendFile(location, data);
                return; // Success!
            } catch (err) {
                // Try next location
                continue;
            }
        }
        
        // All file writes failed, but we still have the data in memory buffer
        console.error('All log file write attempts failed, data preserved in memory');
    }

    getRecentLogs(count = 50) {
        return this.logBuffer.getLast(count).map(entry => entry.formatted);
    }

    getSessionInfo() {
        return {
            startTime: this.sessionStartTime,
            duration: Date.now() - this.sessionStartTime.getTime(),
            totalLogEntries: this.logBuffer.count,
            memoryUsage: process.memoryUsage(),
            nodeVersion: process.version,
            platform: process.platform,
            pid: process.pid
        };
    }

    setLogLevel(level) {
        if (this.logLevels.hasOwnProperty(level)) {
            this.logLevel = level;
            this.info('SessionLogger', `Log level changed to ${level}`);
        }
    }

    logSessionStart() {
        this.info('SessionLogger', '='.repeat(60));
        this.info('SessionLogger', `Valhalla Updater session started`);
        this.info('SessionLogger', `Node.js ${process.version} on ${process.platform}`);
        this.info('SessionLogger', `Process ID: ${process.pid}`);
        this.info('SessionLogger', `Working directory: ${process.cwd()}`);
        this.info('SessionLogger', '='.repeat(60));
    }

    logSessionEnd() {
        const sessionInfo = this.getSessionInfo();
        const duration = moment.duration(sessionInfo.duration).humanize();
        
        this.info('SessionLogger', '='.repeat(60));
        this.info('SessionLogger', `Session ended after ${duration}`);
        this.info('SessionLogger', `Total log entries: ${sessionInfo.totalLogEntries}`);
        this.info('SessionLogger', '='.repeat(60));
    }

    setupPerformanceMonitoring() {
        // Memory threshold monitoring
        setInterval(() => {
            try {
                const memory = process.memoryUsage();
                const heapUsedMB = Math.round(memory.heapUsed / 1024 / 1024);
                const rssMB = Math.round(memory.rss / 1024 / 1024);
                
                // Take memory snapshot
                this.memorySnapshots.push({
                    timestamp: Date.now(),
                    ...memory
                });
                
                // Keep only last 60 snapshots (1 hour of data)
                if (this.memorySnapshots.length > 60) {
                    this.memorySnapshots.shift();
                }
                
                // Log warning if heap usage exceeds 500MB
                if (heapUsedMB > 500) {
                    this.warn('PerformanceMonitor', `High heap usage detected: ${heapUsedMB}MB`);
                }
                
                // Log warning if RSS exceeds 1GB
                if (rssMB > 1024) {
                    this.warn('PerformanceMonitor', `High RSS usage detected: ${rssMB}MB`);
                }
                
                // Check for rapid memory growth
                if (this.memorySnapshots.length >= 5) {
                    const latest = this.memorySnapshots[this.memorySnapshots.length - 1];
                    const fiveMinutesAgo = this.memorySnapshots[this.memorySnapshots.length - 5];
                    const growthMB = Math.round((latest.heapUsed - fiveMinutesAgo.heapUsed) / 1024 / 1024);
                    
                    if (growthMB > 50) {
                        this.warn('PerformanceMonitor', `Rapid memory growth detected: +${growthMB}MB in 5 minutes`);
                    }
                }
            } catch (err) {
                // Performance monitoring failure shouldn't crash anything
            }
        }, 60000); // Check every minute
        
        this.info('SessionLogger', 'Performance monitoring started');
    }

    setupLogRetention() {
        // Clean up old log files daily at 3 AM
        const cleanupTime = moment().startOf('day').add(3, 'hours');
        if (cleanupTime.isBefore(moment())) {
            cleanupTime.add(1, 'day');
        }
        
        const msUntilCleanup = cleanupTime.diff(moment());
        setTimeout(() => {
            this.cleanupOldLogs();
            // Set up daily cleanup
            setInterval(() => this.cleanupOldLogs(), 24 * 60 * 60 * 1000);
        }, msUntilCleanup);
        
        this.info('SessionLogger', `Log cleanup scheduled for ${cleanupTime.format('YYYY-MM-DD HH:mm:ss')}`);
    }

    cleanupOldLogs() {
        try {
            const logsDir = path.join(process.cwd(), 'logs');
            const crashLogsDir = path.join(process.cwd(), 'crash-logs');
            const retentionDays = 7; // Keep logs for 7 days
            const cutoffDate = moment().subtract(retentionDays, 'days');
            
            this.info('SessionLogger', `Starting log cleanup - removing files older than ${cutoffDate.format('YYYY-MM-DD')}`);
            
            let cleanedFiles = 0;
            
            // Clean up regular logs
            if (fs.existsSync(logsDir)) {
                const logFiles = fs.readdirSync(logsDir);
                for (const file of logFiles) {
                    if (file === 'latest.log') continue; // Never delete current log
                    
                    const filePath = path.join(logsDir, file);
                    const stats = fs.statSync(filePath);
                    
                    if (moment(stats.mtime).isBefore(cutoffDate)) {
                        fs.unlinkSync(filePath);
                        cleanedFiles++;
                    }
                }
            }
            
            // Clean up crash logs
            if (fs.existsSync(crashLogsDir)) {
                const crashFiles = fs.readdirSync(crashLogsDir);
                for (const file of crashFiles) {
                    const filePath = path.join(crashLogsDir, file);
                    const stats = fs.statSync(filePath);
                    
                    if (moment(stats.mtime).isBefore(cutoffDate)) {
                        fs.unlinkSync(filePath);
                        cleanedFiles++;
                    }
                }
            }
            
            this.info('SessionLogger', `Log cleanup completed - removed ${cleanedFiles} old files`);
        } catch (err) {
            this.error('SessionLogger', 'Log cleanup failed', err.message);
        }
    }
}

// Global instance
const logger = new SessionLogger();

// Graceful shutdown handling
process.on('SIGINT', () => {
    logger.logSessionEnd();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.logSessionEnd();
    process.exit(0);
});

module.exports = logger;