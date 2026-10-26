import { RedisConfig } from './config';
import { createClient, createCluster } from 'redis';
import { delay } from './util';
import { Static, Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { PackageListener } from './packageListener';
import logger from './logger';
import {
  EncryptionOptions,
  redactKeyMaterialFor,
  redactMessageString
} from './encryption';

export const QueueMessage = Type.Object({
  jobId: Type.String(),
  url: Type.String(),
  // Per-job encryption options, applied to this job only. Never read from
  // instance config.
  encryption: Type.Optional(EncryptionOptions),
  // Per-job callback URL, used for this job instead of the instance-wide
  // CALLBACK_URL. Omitted means the configured callback is used, as before.
  // Basic-auth credentials may be embedded as userinfo, the same format
  // CALLBACK_URL accepts: https://user:password@hostname/path
  callbackUrl: Type.Optional(Type.String({ minLength: 1 }))
});

export type QueueMessage = Static<typeof QueueMessage>;

const QueueMessageChecker = TypeCompiler.Compile(QueueMessage);

const CALLBACK_URL_PROTOCOLS = ['http:', 'https:'];

/**
 * A callback URL has to be absolute and http(s): `CallbackListener` resolves
 * the success/failure path against it and hands it to `fetch`, so a relative
 * or non-http value would only fail later, after the job has been packaged.
 */
/**
 * Basic-auth credentials may be embedded in a callback URL as userinfo, so a
 * message carrying one must not be logged verbatim. Applied on top of the
 * key-material redaction, for the same reason: what leaves this package in a
 * log line or an error must not include a secret.
 */
export function redactUrlCredentials(message: string): string {
  return message.replace(/(https?:\/\/)[^/\s"'@]+@/gi, '$1[REDACTED]@');
}

export function isValidCallbackUrl(callbackUrl: string): boolean {
  if (!URL.canParse(callbackUrl)) {
    return false;
  }
  return CALLBACK_URL_PROTOCOLS.includes(new URL(callbackUrl).protocol);
}

export function validateQueueMessage(
  message: unknown
): asserts message is QueueMessage {
  if (QueueMessageChecker.Check(message)) {
    if (message.callbackUrl && !isValidCallbackUrl(message.callbackUrl)) {
      throw new Error(
        'Invalid message: /callbackUrl must be an absolute http or https URL'
      );
    }
    return;
  } else {
    // Formatted from path and message only: the rejected values are never
    // included, so an invalid encryption key cannot leak into logs or an API
    // error response.
    const errors = [...QueueMessageChecker.Errors(message)]
      .map((error) => `${error.path || '/'} ${error.message}`)
      .join(', ');
    throw new Error(`Invalid message: ${errors}`);
  }
}

export class RedisListener {
  private running = false;
  private noProcessing = 0;

  private client: Awaited<ReturnType<typeof createClient>> | undefined;
  private cluster: Awaited<ReturnType<typeof createCluster>> | undefined;

  private retryClient: Awaited<ReturnType<typeof createClient>> | undefined;
  private retryCluster: Awaited<ReturnType<typeof createCluster>> | undefined;

  constructor(
    private redisConfig: RedisConfig,
    private onMessage: (message: QueueMessage) => Promise<string | void>,
    private concurrency: number = 1,
    private packageListener?: PackageListener,
    // Optional per-job listener resolution. Returning undefined (or leaving
    // this out entirely) keeps the instance-wide `packageListener`.
    private packageListenerFor?: (
      message: QueueMessage
    ) => PackageListener | undefined
  ) {}

  listenerFor(message?: QueueMessage): PackageListener | undefined {
    if (!message || !this.packageListenerFor) {
      return this.packageListener;
    }
    return this.packageListenerFor(message) ?? this.packageListener;
  }

  async start() {
    this.running = true;
    while (this.running) {
      try {
        await this.connect();
        if (this.redisConfig.clusterMode) {
          logger.info('Connected to Redis Cluster');
        }

        if (this.noProcessing < this.concurrency) {
          let message;
          try {
            logger.info('Waiting for message...');
            message = this.redisConfig.clusterMode
              ? await this.cluster?.bzPopMin(this.redisConfig.queueName, 2000)
              : await this.client?.bzPopMin(this.redisConfig.queueName, 2000);
          } catch (err) {
            logger.error(err);
          }
          if (message) {
            this.handleMessage(message.value);
          } else {
            logger.info('No message received, waiting...');
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
    const safeMessage = redactUrlCredentials(redactMessageString(message));
    let parsedMessage: unknown;
    let listener: PackageListener | undefined = this.packageListener;
    try {
      logger.info(`Received message: ${safeMessage}`);
      parsedMessage = JSON.parse(message);
      validateQueueMessage(parsedMessage);
      listener = this.listenerFor(parsedMessage);
      this.noProcessing++;
      try {
        logger.info(
          `Sending message for processing, currently processing ${this.noProcessing} messages`
        );
        this.onPackageStart(parsedMessage.url, parsedMessage.jobId, listener);
        const onMessageResult = await this.onMessage(parsedMessage);
        await this.onPackageDone(
          parsedMessage.url,
          parsedMessage.jobId,
          onMessageResult ? onMessageResult : undefined,
          listener
        );
      } finally {
        this.noProcessing--;
      }
    } catch (e) {
      // An error thrown further down the stack can carry the raw keys, so
      // scrub this job's key material from both the log line and whatever is
      // handed to the package listener. The raw message is passed as well:
      // when JSON.parse is what failed, parsedMessage is undefined and the
      // parse error quotes a fragment of the message itself.
      const detail = redactUrlCredentials(
        redactKeyMaterialFor(`${(e as Error)?.message}`, parsedMessage, message)
      );
      logger.error(`Error when handling message ${safeMessage}: ${detail}`);
      const safeError =
        detail === (e as Error)?.message ? e : new Error(detail);
      await this.onPackageFail(safeMessage, safeError, undefined, listener);
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
      await this.retryCluster?.quit();
      this.retryCluster = undefined;
    }
    await this.client?.quit();
    this.client = undefined;
    await this.retryClient?.quit();
    this.retryClient = undefined;
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

  onPackageStart(
    jobUrl: string,
    jobId: string,
    listener: PackageListener | undefined = this.packageListener
  ) {
    try {
      listener?.onPackageStart?.(jobUrl, jobId);
    } catch (err) {
      logger.warn(
        `Error when calling beforePackage: ${(err as Error).message}`
      );
    }
  }

  async onPackageDone(
    jobUrl: string,
    jobId: string,
    outputPath?: string,
    listener: PackageListener | undefined = this.packageListener
  ) {
    try {
      await listener?.onPackageDone?.(jobUrl, jobId, outputPath);
    } catch (err) {
      logger.warn(
        `Error when calling onPackageDone: ${(err as Error).message}`
      );
    }
  }

  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  async onPackageFail(
    message: string,
    err: any,
    jobId?: string,
    listener: PackageListener | undefined = this.packageListener
  ) {
    try {
      await listener?.onPackageFail?.(message, err);
    } catch (e) {
      logger.warn(`Error when calling onPackageFail: ${(e as Error).message}`);
    }
  }

  async connectRetryClient() {
    if (this.redisConfig.clusterMode) {
      if (this.retryCluster) {
        return;
      }
      this.retryCluster = await createCluster({
        rootNodes: [{ url: this.redisConfig.url }]
      }).on('error', (err) => {
        logger.warn(`Redis Retry Cluster Error: ${(err as Error).message}`);
      });
      await this.retryCluster.connect();
    } else {
      if (this.retryClient) {
        return;
      }
      this.retryClient = await createClient({ url: this.redisConfig.url })
        .on('error', (err) => {
          logger.warn(`Redis Retry Client Error: ${(err as Error).message}`);
        })
        .connect();
    }
  }

  async retryJob(message: QueueMessage): Promise<void> {
    await this.connectRetryClient();
    const messageStr = JSON.stringify(message);

    if (this.redisConfig.clusterMode) {
      await this.retryCluster?.zAdd(this.redisConfig.queueName, {
        score: Date.now(),
        value: messageStr
      });
    } else {
      await this.retryClient?.zAdd(this.redisConfig.queueName, {
        score: Date.now(),
        value: messageStr
      });
    }

    logger.info(
      `Job retried: ${redactUrlCredentials(redactMessageString(messageStr))}`
    );
  }
}
