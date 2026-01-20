/*
 * File: schedulerManager.js
 * Project: valhalla-updater
 * File Created: Wednesday, 15th May 2024 10:14:14 pm
 * Author: flaasz
 * -----
 * Last Modified: Friday, 31st May 2024 2:06:42 am
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

//TODO Restart scheduler with checks
//TODO Automated perms on ptero for team!


const fs = require('fs');
const path = require('path');
const config = require('../config/config.json');
const schedulerConfig = config.scheduler;
const sessionLogger = require('../modules/sessionLogger');

module.exports = {
    loadSchedulers: function (init = false) {
        try {
            sessionLogger.info('SchedulerManager', 'Loading schedulers...');
            
            const schedulersPath = path.join(__dirname, '../schedulers');
            const schedulerFiles = fs.readdirSync(schedulersPath).filter(file => file.endsWith('.js'));
            sessionLogger.info('SchedulerManager', `Found ${schedulerFiles.length} scheduler files`);

            let schedulers = 0;
            let activeSchedulers = 0;
            
            for (const file of schedulerFiles) {
                schedulers++;
                const filePath = path.join(schedulersPath, file);
                
                try {
                    const scheduler = require(filePath);

                    if ('name' in scheduler && 'start' in scheduler || 'defaultConfig' in scheduler) {
                        if (!schedulerConfig[scheduler.name]) {
                            sessionLogger.warn('SchedulerManager', `No config found for ${scheduler.name} scheduler, generating default config`);
                            schedulerConfig[scheduler.name] = scheduler.defaultConfig;

                            const configPath = path.join(__dirname, '../config/config.json');
                            fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
                            sessionLogger.info('SchedulerManager', `Generated default config for ${scheduler.name}`);
                        }

                        if (schedulerConfig[scheduler.name].active && !init) {
                            activeSchedulers++;
                            sessionLogger.info('SchedulerManager', `Starting ${scheduler.name} scheduler`);
                            scheduler.start(schedulerConfig[scheduler.name]);
                        } else if (!init) {
                            sessionLogger.debug('SchedulerManager', `Skipping ${scheduler.name} scheduler (inactive)`);
                        }
                    } else {
                        sessionLogger.error('SchedulerManager', `Scheduler ${file} is missing required properties (name, start, or defaultConfig)`);
                    }
                } catch (error) {
                    sessionLogger.error('SchedulerManager', `Failed to load scheduler ${file}`, error.message);
                }
            }

            if (!init) {
                sessionLogger.info('SchedulerManager', `Loaded ${schedulers} schedulers (${activeSchedulers} active)`);
            }
        } catch (error) {
            sessionLogger.error('SchedulerManager', 'Failed to load schedulers', error.message);
            throw error;
        }
    }
};