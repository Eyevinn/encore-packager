# Encore packager

[![Badge OSC](https://img.shields.io/badge/Evaluate-24243B?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTIiIGZpbGw9InVybCgjcGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyKSIvPgo8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI3IiBzdHJva2U9ImJsYWNrIiBzdHJva2Utd2lkdGg9IjIiLz4KPGRlZnM%2BCjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyIiB4MT0iMTIiIHkxPSIwIiB4Mj0iMTIiIHkyPSIyNCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjQzE4M0ZGIi8%2BCjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzREQzlGRiIvPgo8L2xpbmVhckdyYWRpZW50Pgo8L2RlZnM%2BCjwvc3ZnPgo%3D)](https://app.osaas.io/browse/eyevinn-encore-packager)

Wrapper for packaging output of an [encore](https://github.com/svt/encore) transcoding job with Shaka Packager.

Can be run either as a CLI or as a service. In the latter case it will listen for messages on a redis queue and
package the output of the transcoding job referenced by the message.

The packager supports two modes of operation:

- **Standard mode**: Package video files using Shaka Packager for DASH/HLS output
- **Skip packaging mode**: Copy source MP4 files and generate SMIL playlists for direct streaming

## Requirements

[shaka packager](https://github.com/shaka-project/shaka-packager) needs to be installed for standard packaging mode. Unless the shaka executable is named `packager` and is in `PATH`, the path to the executable must be provided as an environment variable `SHAKA_PACKAGER_EXECUTABLE`.

**Note**: Shaka Packager is not required when using skip packaging mode (`--skip-packaging` or `SKIP_PACKAGING=true`).

## Usage

### CLI

#### Standard Packaging Mode

```bash
# Package files with Shaka Packager (default behavior)
encore-packager -u https://encore.example.com/api/encoreJobs/123
```

#### Skip Packaging Mode

```bash
# Copy MP4 files and generate SMIL playlist
encore-packager -u https://encore.example.com/api/encoreJobs/123 --skip-packaging

# Using short option
encore-packager -u https://encore.example.com/api/encoreJobs/123 -s

# Using environment variable
SKIP_PACKAGING=true encore-packager -u https://encore.example.com/api/encoreJobs/123
```

In skip packaging mode, the tool will:

- Copy all MP4 video files from the Encore job output
- Generate a SMIL playlist file (`playlist.smil`) with bitrate information
- Support both local file copying and HTTP(S) URL downloading
- Create the same output folder structure as standard packaging mode

### Running as a service

When running as a service, the packager can be configured to use skip packaging mode for all jobs by setting the `SKIP_PACKAGING` environment variable.

```bash
# Standard packaging mode (default)
npm run start

# Skip packaging mode for all jobs
SKIP_PACKAGING=true npm run start
```

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
| `SKIP_PACKAGING`              | Skip Shaka Packager and copy MP4 files with SMIL generation instead. Set to `true` to enable                                                                                                                                          | `false`                  |
| `SMIL_BASE_URL`               | Optional base URL to include in generated SMIL files. Used for resolving relative video file paths                                                                                                                                    |                          |

##### Stream key templates

Stream key templates can be used to set the 'key' for each stream, which decides how the stream is identified in the packaged manifest.

Keywords in the template are replaced with values according to the table below.

| Keyword      | Value                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$VIDEOIDX$` | Video stream index, starting from 0                                                                                                               |
| `$AUDIOIDX$` | Audio stream index, starting from 0                                                                                                               |
| `$TOTALIDX$` | Total stream index. For video streams, this is the video stream index. For Audio streams, this is audio stream index plus number of video streams |
| `$BITRATE$`  | Bitrate of the stream                                                                                                                             |

#### SMIL Output Format (Skip Packaging Mode)

When using skip packaging mode, a SMIL (Synchronized Multimedia Integration Language) file is generated alongside the copied MP4 files. The SMIL file provides a playlist format that can be used for adaptive bitrate streaming.

**Example SMIL output structure:**

```
output-folder/
├── video_1080p.mp4
├── video_720p.mp4
├── video_480p.mp4
└── playlist.smil
```

**Example SMIL file content:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<smil xmlns="http://www.w3.org/2001/SMIL20/Language">
  <head>
    <meta base="https://example.com/videos/" />
  </head>
  <body>
    <switch>
      <video src="video_1080p.mp4" system-bitrate="5000000" />
      <video src="video_720p.mp4" system-bitrate="3000000" />
      <video src="video_480p.mp4" system-bitrate="1500000" />
    </switch>
  </body>
</smil>
```

The SMIL file includes:

- Bitrate information for each video rendition
- Base URL for resolving relative paths (configurable via `SMIL_BASE_URL`)
- Standard SMIL switch element for adaptive playback

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
