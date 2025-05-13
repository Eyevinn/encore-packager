import { RedisConfig } from './config';
import { createClient, createCluster } from 'redis';
import { delay } from './util';
import { Static, Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { PackageListener } from './packageListener';
import logger from './logger';

export const QueueMessage = Type.Object({
  jobId: Type.String(),
  url: Type.String()
});

export type QueueMessage = Static<typeof QueueMessage>;

const QueueMessageChecker = TypeCompiler.Compile(QueueMessage);

export function validateQueueMessage(message: unknown) {
  if (!QueueMessageChecker.Check(message)) {
    const errors = QueueMessageChecker.Errors(message);
    throw new Error(`Invalid message: ${errors}`);
  }
}

export class RedisListener {
  private running = false;
  private noProcessing = 0;

  private client: Awaited<ReturnType<typeof createClient>> | undefined;
  private cluster: Awaited<ReturnType<typeof createCluster>> | undefined;

  constructor(
    private redisConfig: RedisConfig,
    private onMessage: (message: QueueMessage) => Promise<string | void>,
    private concurrency: number = 1,
    private packageListener?: PackageListener
  ) {}

  async start() {
    this.running = true;
    while (this.running) {
      try {
        await this.connect();
        const client = this.redisConfig.clusterMode
          ? this.cluster
          : this.client;
        if (this.noProcessing < this.concurrency) {
          let message;
          try {
            message = await client?.bzPopMin(this.redisConfig.queueName, 2000);
          } catch (err) {
            logger.error(err);
          }
          if (message) {
            this.handleMessage(message.value);
          }
        } else {
          await delay(1000);
        }
      } catch (err) {
        logger.error(`Error when processing queue: ${(err as Error)?.message}`);
        await delay(3000);
      }
    }
  }

  async stop() {
    this.running = false;
    await this.disconnect();
  }

  async handleMessage(message: string) {
    try {
      logger.info(`Received message: ${message}`);
      const parsedMessage = JSON.parse(message);
      validateQueueMessage(parsedMessage);
      this.noProcessing++;
      try {
        logger.info(
          `Sending message for processing, currently processing ${this.noProcessing} messages`
        );
        this.onPackageStart(parsedMessage.url, parsedMessage.jobId);
        const onMessageResult = await this.onMessage(parsedMessage);
        this.onPackageDone(
          parsedMessage.url,
          parsedMessage.jobId,
          onMessageResult ? onMessageResult : undefined
        );
      } finally {
        this.noProcessing--;
      }
    } catch (e) {
      logger.error(
        `Error when handling message ${message}: ${(e as Error)?.message}`
      );
      this.onPackageFail(message, e);
    }
  }

  async connect() {
    if (this.redisConfig.clusterMode) {
      if (this.cluster) {
        return;
      }
      this.cluster = await createCluster({
        rootNodes: [{ url: this.redisConfig.url }]
      }).on('error', (err) => {
        logger.warn(`Redis Cluster Error: ${(err as Error).message}`);
      });
      await this.cluster.connect();
    } else {
      if (this.client) {
        return;
      }
      this.client = await createClient({ url: this.redisConfig.url })
        .on('error', (err) => {
          logger.warn(`Redis Client Error: ${(err as Error).message}`);
        })
        .connect();
    }
  }

  async disconnect() {
    if (this.redisConfig.clusterMode) {
      await this.cluster?.quit();
      this.cluster = undefined;
    }
    await this.client?.quit();
    this.client = undefined;
  }

  redisStatus(): 'UP' | 'DOWN' {
    if (this.redisConfig.clusterMode) {
      // node-redis doesn't support isReady for cluster mode
      // https://github.com/redis/node-redis/issues/1855
      // so we have to hard-code this for now
      return 'UP';
    }
    if (!this.client) {
      return 'UP';
    }
    return this.client.isReady ? 'UP' : 'DOWN';
  }

  onPackageStart(jobUrl: string, jobId: string) {
    try {
      this.packageListener?.onPackageStart?.(jobUrl, jobId);
    } catch (err) {
      logger.warn(
        `Error when calling beforePackage: ${(err as Error).message}`
      );
    }
  }

  onPackageDone(jobUrl: string, jobId: string, outputPath?: string) {
    try {
      this.packageListener?.onPackageDone?.(jobUrl, jobId, outputPath);
    } catch (err) {
      logger.warn(
        `Error when calling onPackageDone: ${(err as Error).message}`
      );
    }
  }

  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  onPackageFail(message: string, err: any, jobId?: string) {
    try {
      this.packageListener?.onPackageFail?.(message, err);
    } catch (e) {
      logger.warn(`Error when calling onPackageFail: ${(e as Error).message}`);
    }
  }
}
