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

| Variable                      | Description                                                                                                                                                                                                                           | Default value            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `REDIS_URL`                   | URL to the redis server                                                                                                                                                                                                               | `redis://localhost:6379` |
| `REDIS_QUEUE`                 | Name of the redis queue to listen to                                                                                                                                                                                                  | `packaging-queue`        |
| `HOST`                        | Hostname or IP address to bind to for healtchechk endpoint                                                                                                                                                                            | `0.0.0.0`                |
| `PORT`                        | Port to bind to for healtchechk endpoint                                                                                                                                                                                              | `8000`                   |
| `DISABLE_HEALTCHECK`          | Disable the healthcheck endpoint                                                                                                                                                                                                      | `false`                  |
| `SHAKA_PACKAGER_EXECUTABLE`   | Path to the shaka packager executable                                                                                                                                                                                                 | `packager`               |
| `PACKAGE_OUTPUT_FOLDER`       | Base folder for output, actual output will be in a subfolder according to `OUTPUT_SUBFOLDER_TEMPLATE`                                                                                                                                 | `packaged`               |
| `PACKAGE_CONCURRENCY`         | Number of concurrent packaging jobs                                                                                                                                                                                                   | `1`                      |
| `PACKAGE_LISTENER_PLUGIN`     | Optional path to a javascript file containing a custom listener for packaging event, see below                                                                                                                                        |                          |
| `PACKAGE_FORMAT_OPTIONS_JSON` | Optional JSON string with format options for shaka packager, format as defined in https://github.com/Eyevinn/shaka-packager-s3/blob/main/src/packager.ts                                                                              |
| `VIDEO_STREAM_KEY_TEMPLATE`   | Optional template for video stream key, see below for supported keywords                                                                                                                                                              | `$VIDEOIDX$_$BITRATE$`   |
| `AUDIO_STREAM_KEY_TEMPLATE`   | Optional template for video stream key, see below for supported keywords                                                                                                                                                              | `$AUDIOIDX$`             |
| `OUTPUT_SUBFOLDER_TEMPLATE`   | Template for subfolder relative to `PACKAGE_OUTPUT_FOLDER` where output will be stored. Keywords `$INPUTNAME$`, `$JOBID$`, and `$EXTERNALID$` will be replaced with basename of input, id, and external id of encore job respectively | `$INPUTNAME$/$JOBID$`    |
| `DASH_MANIFEST_NAME_TEMPLATE` | Template for name of DASH manifest file. Keywords `$INPUTNAME$` and `$JOBID$` will be replaced with basename of input, and id of encore job respectively. If unset, uses default from `shaka-packager-s3` library `manifest.mpd`      |                          |
| `HLS_MANIFEST_NAME_TEMPLATE`  | Template for name of HLS manifest file. Keywords `$INPUTNAME$` and `$JOBID$` will be replaced with basename of input, and id of encore job respectively. If unset, uses default from `shaka-packager-s3` library, `index.m3u8`        |                          |
| `ENCORE_PASSWORD`             | Optional password for the encore instance `user` user                                                                                                                                                                                 |                          |
| `OSC_ACCESS_TOKEN`            | Optional OSC access token for accessing Encore instance in OSC                                                                                                                                                                        |                          |
| `AWS_ACCESS_KEY_ID`           | Optional AWS access key id when `PACKAGE_OUTPUT_FOLDER` is an AWS S3 bucket                                                                                                                                                           |                          |
| `AWS_SECRET_ACCESS_KEY`       | Optional AWS secret access key when `PACKAGE_OUTPUT_FOLDER` is an AWS S3 bucket                                                                                                                                                       |                          |
| `S3_ENDPOINT_URL`             | Optional S3 Endpoint URL when `PACKAGE_OUTPUT_FOLDER` is an S3 bucket not on AWS                                                                                                                                                      |                          |
| `CALLBACK_URL`                | Optional callback service url. If enabled, the packager will send callbacks on packaging success or failure. To use baisc auth, provide the URL in the format `https://user:password@hostname/path`                                   |                          |

##### Stream key templates

Stream key templates can be used to set the 'key' for each stream, which decides how the stream is identified in the packaged manifest.

Keywords in the template are replaced with values according to the table below.

| Keyword      | Value                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$VIDEOIDX$` | Video stream index, starting from 0                                                                                                               |
| `$AUDIOIDX$` | Audio stream index, starting from 0                                                                                                               |
| `$TOTALIDX$` | Total stream index. For video streams, this is the video stream index. For Audio streams, this is audio stream index plus number of video streams |
| `$BITRATE$`  | Bitrate of the stream                                                                                                                             |

#### Starting the service

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
