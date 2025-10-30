// #! /usr/bin/env node

import { Command } from 'commander';
import { startListener } from './server';
import { readConfig } from './config';
import { EncorePackager } from './encorePackager';
import logger from './logger';

const cli = new Command();

cli
  .description('Package files transcoded with encore with shaka packager')
  .option('-u, --url [url]', 'URL to encore job')
  .option(
    '-r, --redis-listener [redisListener]',
    'Run in service mode, listening to redis queue for jobs'
  )
  .option(
    '-s, --skip-packaging',
    'Skip packaging and copy source MP4 files with SMIL generation'
  )
  .action(async (options) => {
    if (options.redisListener) {
      if (options.url) {
        logger.warn('Ignoring URL option when running in service mode');
      }
      await startListener(readConfig());
    } else {
      if (!options.url) {
        cli.help();
        process.exit(1);
      }
      const config = readConfig();
      const packager = new EncorePackager(config.packaging);
      const skipPackaging = options.skipPackaging;
      if (skipPackaging) {
        await packager.copyAndGenerateSmil(options.url);
      } else {
        await packager.package(options.url);
      }
    }
  });

cli.parse(process.argv);
