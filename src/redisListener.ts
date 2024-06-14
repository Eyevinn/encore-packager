import { RedisConfig } from './config';
import { createClient } from 'redis';
import { delay } from './util';
import { Static, Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

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
  constructor(
    private redisConfig: RedisConfig,
    private onMessage: (message: QueueMessage) => Promise<void>,
    private concurrency: number = 1
  ) {}

  async start() {
    this.running = true;
    while (this.running) {
      try {
        await this.connect();
        if (this.noProcessing < this.concurrency) {
          let message;
          try {
            message = await this.client?.bzPopMin(
              this.redisConfig.queueName,
              2000
            );
            console.log(message);
          } catch (err) {
            console.error(err);
          }
          if (message) {
            this.handleMessage(message.value);
          }
        } else {
          await delay(1000);
        }
      } catch (err) {
        console.error('Error when processing queue', err);
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
      console.log(`Recevied message: ${message}`);
      const parsedMessage = JSON.parse(message);
      validateQueueMessage(parsedMessage);
      this.noProcessing++;
      try {
        console.log(
          `Sending message for processing, currently processing ${this.noProcessing} messages`
        );
        await this.onMessage(parsedMessage);
      } finally {
        this.noProcessing--;
      }
    } catch (e) {
      console.log(`Error when handling message: ${message}`);
    }
  }

  async connect() {
    if (this.client) {
      return;
    }
    this.client = await createClient({ url: this.redisConfig.url })
      .on('error', (err) => {
        console.log('Redis Client Error', err);
        this.redisUp = false;
      })
      .connect();
    this.redisUp = true;
  }

  async disconnect() {
    await this.client?.quit();
    this.client = undefined;
  }

  redisStatus(): 'UP' | 'DOWN' {
    if (!this.client) {
      return 'UP';
    }
    return this.client.isReady ? 'UP' : 'DOWN';
  }
}
