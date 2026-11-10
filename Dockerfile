ARG NODE_IMAGE=node:26.12.1-alpine3.24

# Note: This target is the one build by CI and published to dockerhub
FROM ${NODE_IMAGE} AS without-volume-definition
ENV NODE_ENV=production
EXPOSE 8000
RUN apk --no-cache upgrade \
    && apk --no-cache add 'brotli-libs>=1.2.1-r0' curl aws-cli
RUN mkdir /app
RUN chown node:node /app
USER node
WORKDIR /app
COPY --chown=node:node ["package.json", "package-lock.json*", "tsconfig*.json", "./"]
COPY --chown=node:node ["src", "./src"]
# Delete prepare script to avoid errors from husky
RUN npm pkg delete scripts.prepare \
    && npm ci --omit=dev
COPY --from=google/shaka-packager:v3.4.2 /usr/bin/packager /usr/bin/packager
CMD [ "npm", "run", "start", "--", "-r" ]

FROM without-volume-definition
VOLUME [ "/data" ]
ENV STAGING_DIR=/data
ENV TMPDIR=/data

