# Encore packager

Wrapper for packaging output of an [encore](https://github.com/svt/encore) transcoding job with Shaka Packager.

Kan be run either as a CLI or as a service. In the latter case it will listen for messages on a redis queue and
package the output of the transcoding job referenced by the message.

## Requirements

[shaka packager](https://github.com/shaka-project/shaka-packager) needs to be installed. Unless the shaka executable is named `packager` and is in `PATH`, the path to the executable must be provided as an environment variable `SHAKA_PACKAGER_EXECUTABLE`.

## Usage

### CLI

### Running as a service

#### Environment variables

| Variable                    | Description                                                                                  | Default value            |
| --------------------------- | -------------------------------------------------------------------------------------------- | ------------------------ |
| `REDIS_URL`                 | URL to the redis server                                                                      | `redis://localhost:6379` |
| `REDIS_QUEUE`               | Name of the redis queue to listen to                                                         | `packaging-queue`        |
| `HOST`                      | Hostname or IP address to bind to for healtchechk endpoint                                   | `0.0.0.0`                |
| `PORT`                      | Port to bind to for healtchechk endpoint                                                     | `8000`                   |
| `DISABLE_HEALTCHECK`        | Disable the healthcheck endpoint                                                             | `false`                  |
| `SHAKA_PACKAGER_EXECUTABLE` | Path to the shaka packager executable                                                        | `packager`               |
| `PACKAGE_OUTPUT_FOLDER`     | Base folder for output, actual output will be in a subfolder named from the job id           | `packaged`               |
| `PACKAGE_CONCURRENCY`       | Number of concurrent packaging jobs                                                          | `1`                      |
| `PACKAGE_LISTENER_PLUGIN`   | Optional path to a javascript file containing a custom listener for packaging event, see below |                          |
| `ENCORE_PASSWORD`           | Optional password for the encore instance `user` user                                        |                          |

```bash
npm run start
```

### Custom packager listener

To implement a custom listener that reacts to package events, provide a path to a javascript file
in the `PACKAGE_LISTENER_PLUGIN` environment variable. Example file below, not all methods need to be defined.

```javascript
export function onPackageDone(url) {
  console.log(`Package done: ${url}`);
}

export function onPackageFail(msg, err) {
  console.log(`Package fail: ${msg}, ${err.message}`);
}

export function onPackageStart(url) {
  console.log(`Package start: ${url}`);
}
```

<!--

## Requirements
Add any external project dependencies such as node.js version etc here

## Installation / Usage

Add clear instructions on how to use the project here

## Development

Add clear instructions on how to start development of the project here

-->

### Contributing

See [CONTRIBUTING](CONTRIBUTING.md)

# Support

Join our [community on Slack](http://slack.streamingtech.se) where you can post any questions regarding any of our open source projects. Eyevinn's consulting business can also offer you:

- Further development of this component
- Customization and integration of this component into your platform
- Support and maintenance agreement

Contact [sales@eyevinn.se](mailto:sales@eyevinn.se) if you are interested.

# About Eyevinn Technology

[Eyevinn Technology](https://www.eyevinntechnology.se) is an independent consultant firm specialized in video and streaming. Independent in a way that we are not commercially tied to any platform or technology vendor. As our way to innovate and push the industry forward we develop proof-of-concepts and tools. The things we learn and the code we write we share with the industry in [blogs](https://dev.to/video) and by open sourcing the code we have written.

Want to know more about Eyevinn and how it is to work here. Contact us at work@eyevinn.se!
