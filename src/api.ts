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

  // Register Swagger
  api.register(import('@fastify/swagger'), {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'Encore Packager API',
        description: 'API for managing packaging jobs and health checks',
        version: '1.0.0'
      },
      servers: [
        {
          url: 'http://localhost:3000',
          description: 'Development server'
        }
      ],
      components: {
        schemas: {
          QueueMessage: {
            type: 'object',
            properties: {
              jobId: {
                type: 'string',
                description: 'Unique identifier for the job'
              },
              url: {
                type: 'string',
                description: 'URL to be processed'
              }
            },
            required: ['jobId', 'url']
          },
          Health: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                description: 'Overall service status'
              },
              redis: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    description: 'Redis connection status'
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  // Register Swagger UI
  api.register(import('@fastify/swagger-ui'), {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'full',
      deepLinking: false
    },
    uiHooks: {
      onRequest: function (request, reply, next) {
        next();
      },
      preHandler: function (request, reply, next) {
        next();
      }
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
    transformSpecification: (swaggerObject) => {
      return swaggerObject;
    },
    transformSpecificationClone: true
  });

  // register the cors plugin, configure it for better security
  api.register(cors);

  api.register(healthcheck, opts);
  // register other API routes here

  return api;
};
