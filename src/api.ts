import fastify from 'fastify';
import cors from '@fastify/cors';
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

export default () => {
  const api = fastify({
    ignoreTrailingSlash: true
  }).withTypeProvider<TypeBoxTypeProvider>();

  // register the cors plugin, configure it for better security
  api.register(cors);

  api.register(healthcheck, null as never);
  // register other API routes here

  return api;
};
