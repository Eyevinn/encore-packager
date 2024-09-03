ARG NODE_IMAGE=node:18-alpine

# Note: This target is the one build by CI and published to dockerhub
FROM ${NODE_IMAGE} AS without-volume-definition
ENV NODE_ENV=production
EXPOSE 8000
RUN apk --no-cache add curl
RUN apk --no-cache add aws-cli
RUN mkdir /app
RUN chown node:node /app
USER node
WORKDIR /app
COPY --chown=node:node ["package.json", "package-lock.json*", "tsconfig*.json", "./"]
COPY --chown=node:node ["src", "./src"]
# Delete prepare script to avoid errors from husky
RUN npm pkg delete scripts.prepare \
    && npm ci --omit=dev
COPY --from=google/shaka-packager:v3.2.0 /usr/bin/packager /usr/bin/packager
CMD [ "npm", "run", "start", "--", "-r" ]

FROM without-volume-definition
VOLUME [ "/data" ]
ENV STAGING_DIR=/data
ENV TMPDIR=/data

