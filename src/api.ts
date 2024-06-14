import fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';

const Health = Type.Object({
  status: Type.String()
});

const healthcheck: FastifyPluginCallback<never> = (fastify, opts, next) => {
  fastify.get<{ Reply: Static<typeof Health> }>(
    '/healthcheck',
    {
      schema: {
        description: 'Healthcheck endpoint',
        response: {
          200: Health
        }
      }
    },
    async (_, reply) => {
      reply.send({ status: 'up' });
    }
  );
  next();
};

export interface ApiOptions {
  title: string;
}

export default (opts: ApiOptions) => {
  const api = fastify({
    ignoreTrailingSlash: true
  }).withTypeProvider<TypeBoxTypeProvider>();

  // register the cors plugin, configure it for better security
  api.register(cors);

  // register the swagger plugins, it will automagically do magic
  api.register(swagger, {
    swagger: {
      info: {
        title: opts.title,
        description: 'hello',
        version: 'v1'
      }
    }
  });
  api.register(swaggerUI, {
    routePrefix: '/docs'
  });

  api.register(healthcheck, {});
  // register other API routes here

  return api;
};
