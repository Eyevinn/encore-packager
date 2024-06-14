import fastify from 'fastify';
import cors from '@fastify/cors';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';

const Health = Type.Object({
  status: Type.String(),
  redis: Type.Object({
    status: Type.String()
  })
});

interface HealthcheckOptions {
  redisStatus: () => 'UP' | 'DOWN';
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
        response: {
          200: Health
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
  next();
};

export interface ApiOptions {
  title: string;
}

export default (opts: HealthcheckOptions) => {
  const api = fastify({
    ignoreTrailingSlash: true
  }).withTypeProvider<TypeBoxTypeProvider>();

  // register the cors plugin, configure it for better security
  api.register(cors);

  api.register(healthcheck, opts);
  // register other API routes here

  return api;
};
