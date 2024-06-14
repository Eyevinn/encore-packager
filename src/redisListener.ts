import { RedisConfig } from './config';
import { createClient } from 'redis';
import { QueueMessage, validateQueueMessage } from './model';
import { delay } from './util';

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
    await this.connect();
    this.running = true;
    while (this.running) {
      try {
        if (this.noProcessing < this.concurrency) {
          const message = await this.client.bzPopMin(
            this.redisConfig.queueName,
            2000
          );
          if (message) {
            this.handleMessage(message.value);
          }
        } else {
          await delay(1000);
        }
      } catch (err) {
        console.error('Error when polling queue', err);
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
      .on('error', (err) => console.log('Redis Client Error', err))
      .connect();
  }

  async disconnect() {
    await this.client?.disconnect();
    this.client = undefined;
  }
}
