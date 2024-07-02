// #! /usr/bin/env node

import { Command } from 'commander';
import { startListener } from './server';
import { readConfig } from './config';
import { EncorePackager } from './encorePackager';

const cli = new Command();

cli
  .description('Package files transcoded with encore with shaka packager')
  .option('-u, --url [url]', 'URL to encore job')
  .option(
    '-r, --redis-listener [redisListener]',
    'Run in service mode, listening to redis queue for jobs'
  )
  .action(async (options) => {
    if (options.redisListener) {
      if (options.url) {
        console.warn('Ignoring URL option when running in service mode');
      }
      await startListener(readConfig());
    } else {
      if (!options.url) {
        cli.help();
        process.exit(1);
      }
      await new EncorePackager(readConfig().packaging).package(options.url);
    }
  });

cli.parse(process.argv);
