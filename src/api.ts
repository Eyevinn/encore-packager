import fastify from 'fastify';
import cors from '@fastify/cors';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { QueueMessage, validateQueueMessage } from './redisListener';

const Health = Type.Object({
  status: Type.String(),
  redis: Type.Object({
    status: Type.String()
  })
});

interface HealthcheckOptions {
  redisStatus: () => 'UP' | 'DOWN';
  retryJob: (message: Static<typeof QueueMessage>) => Promise<void>;
  title: string;
  description: string;
}

const healthcheck: FastifyPluginCallback<HealthcheckOptions> = (
  fastify,
  opts,
  next
) => {
  fastify.get<{ Reply: Static<typeof Health> }>(
    '/healthcheck',
    {
      schema: {
        description:
          'Check the health status of the service and Redis connection',
        tags: ['Health'],
        summary: 'Health check endpoint',
        response: {
          200: {
            ...Health,
            description: 'Service is healthy'
          },
          503: {
            ...Health,
            description: 'Service is unhealthy'
          }
        }
      }
    },
    async (_, reply) => {
      const status = opts.redisStatus();
      reply.code(status === 'UP' ? 200 : 503).send({
        status: status,
        redis: {
          status
        }
      });
    }
  );

  fastify.post<{ Body: Static<typeof QueueMessage> }>(
    '/retry',
    {
      schema: {
        description: 'Retry a job by adding it back to the processing queue',
        tags: ['Jobs'],
        summary: 'Retry a job',
        body: QueueMessage,
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' }
            },
            description: 'Job successfully queued for retry'
          },
          400: {
            type: 'object',
            properties: {
              error: { type: 'string' }
            },
            description: 'Invalid request body or validation error'
          }
        }
      }
    },
    async (request, reply) => {
      try {
        validateQueueMessage(request.body);
        await opts.retryJob(request.body);
        reply.send({ message: 'Job queued for retry' });
      } catch (error) {
        reply.code(400).send({ error: (error as Error).message });
      }
    }
  );
  next();
};

export interface ApiOptions {
  title: string;
}

export default (opts: HealthcheckOptions) => {
  const api = fastify({
    ignoreTrailingSlash: true
  }).withTypeProvider<TypeBoxTypeProvider>();

  api.register(import('@fastify/swagger'), {
    swagger: {
      info: {
        title: opts.title,
        description: opts.description,
        version: 'v1'
      },
      securityDefinitions: {
        apiKey: {
          type: 'apiKey',
          name: 'Authorization',
          in: 'header',
          description: 'Bearer <API-KEY>'
        }
      }
    }
  });
  api.register(import('@fastify/swagger-ui'), {
    routePrefix: '/docs'
  });

  // register the cors plugin, configure it for better security
  api.register(cors);

  api.register(healthcheck, opts);
  // register other API routes here

  return api;
};
