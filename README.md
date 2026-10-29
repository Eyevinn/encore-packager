# Encore packager

---

<div align="center">

## Quick Demo: Open Source Cloud

Run this service in the cloud with a single click.

[![Badge OSC](https://img.shields.io/badge/Try%20it%20out!-1E3A8A?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTIiIGZpbGw9InVybCgjcGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyKSIvPgo8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI3IiBzdHJva2U9ImJsYWNrIiBzdHJva2Utd2lkdGg9IjIiLz4KPGRlZnM+CjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyIiB4MT0iMTIiIHkxPSIwIiB4Mj0iMTIiIHkyPSIyNCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjQzE4M0ZGIi8+CjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzREQzlGRiIvPgo8L2xpbmVhckdyYWRpZW50Pgo8L2RlZnM+Cjwvc3ZnPgo=)](https://app.osaas.io/browse/eyevinn-encore-packager)

</div>

---

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

#### AAC priming workaround

Set `TRIM_AAC_PRIMING_SAMPLES=true` to enable the opt-in post-packaging AAC
priming workaround. It is disabled by default and is configured through the
service environment; there is no CLI flag. When enabled, the packaged output
is staged locally, rewritten, and uploaded a second time, so it requires extra
temporary disk space and time. For S3 destinations, the `aws` CLI must be
available to perform the upload.

Downloaded source inputs are removed from the temporary staging tree before
uploading for both local and S3 destinations, so they are not published as
part of the processed package. The generated audio HLS and DASH manifests are
updated along with the media timeline.

Configured DASH and HLS manifest names are respected. If a manifest expected
for the selected output format is missing, or if post-processing cannot write
the rewritten media, the packaging job fails rather than publishing a partial
or stale package.

The workaround applies only to segmented, clear AAC renditions. Encrypted audio
and `segmentSingleFile` output are left unchanged. Unsupported or unexpected
rendition layouts are skipped with a warning and the rest of the package is
still uploaded.

### Running as a service

When running as a service, the packager can be configured to use skip packaging mode for all jobs by setting the `SKIP_PACKAGING` environment variable.

```bash
# Standard packaging mode (default)
npm run start -- -r

# Skip packaging mode for all jobs
SKIP_PACKAGING=true npm run start -- -r
```

#### Queue name

The name of the queue to listen to is set with the `REDIS_QUEUE` environment
variable (see the environment variable table below for its default). The name is
used exactly as given, with no prefix or namespace added. The server itself is
selected separately with `REDIS_URL`, and setting `REDIS_CLUSTER=true` connects
to it as a cluster root node instead of a single server.

```bash
REDIS_QUEUE=my-packaging-queue npm run start -- -r
```

An instance listens to exactly one queue, read from the environment at startup.
There is no filtering or routing of messages within a queue: every message the
packager pops is processed. Separating work therefore means running one instance
per queue, and having whatever produces the messages choose which queue to add
to.

The queue is a redis **sorted set**, not a list. The packager pops the member
with the lowest score using `BZPOPMIN`, so producers add jobs with `ZADD` and
can use the score to order them:

```bash
redis-cli ZADD packaging-queue 1 '{"jobId":"e5e76304-744c-41d6-85f7-69007b3b1a65","url":"http://encore:8080/encoreJobs/e5e76304-744c-41d6-85f7-69007b3b1a65"}'
```

The pop is blocking. The listener calls `BZPOPMIN` with a timeout argument of
`2000`, and redis reads that argument as seconds, so an idle listener stays
blocked on the queue for up to roughly 33 minutes before the loop comes round
and waits again.

Nothing in this package adds jobs to the queue apart from the retry endpoint,
which re-adds a job with the current timestamp as its score. Producing the
initial job messages is up to whatever triggers packaging.

#### Queue message format

Each message on the redis queue references one encore job:

```json
{
  "jobId": "e5e76304-744c-41d6-85f7-69007b3b1a65",
  "url": "http://encore:8080/encoreJobs/e5e76304-744c-41d6-85f7-69007b3b1a65"
}
```

A message may also carry an optional `encryption` object, which applies to that
job only and is never read from the instance configuration:

```json
{
  "jobId": "e5e76304-744c-41d6-85f7-69007b3b1a65",
  "url": "http://encore:8080/encoreJobs/e5e76304-744c-41d6-85f7-69007b3b1a65",
  "encryption": {
    "scheme": "cenc",
    "keys": [
      {
        "label": "HD",
        "keyId": "00112233445566778899aabbccddeeff",
        "key": "<32 hex characters>"
      }
    ],
    "protectionSystems": ["widevine", "playready"],
    "pssh": { "widevine": "<base64>" },
    "hlsKeyUri": "skd://00112233445566778899aabbccddeeff",
    "clearLead": 0
  }
}
```

| Field               | Required | Description                                                                                |
| ------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `scheme`            | yes      | `cenc` or `cbcs`                                                                           |
| `keys`              | yes      | At least one key. `keyId` and `key` are 16 bytes as 32 hex characters, `label` is optional |
| `protectionSystems` | no       | Any of `widevine`, `playready`, `fairplay`, `marlin`, `common`                             |
| `pssh`              | no       | Pre-built PSSH boxes, base64                                                               |
| `hlsKeyUri`         | no       | Key URI to signal in the HLS playlists                                                     |
| `clearLead`         | no       | Seconds of unencrypted lead-in                                                             |

Unknown members are rejected rather than ignored, on the queue and on
`POST /retry` alike: a misspelled `clear_lead` fails the job instead of
quietly packaging it without a clear lead.

Key values are redacted (`[REDACTED]`) in every log line, error message and
retry log, so key material only ever leaves this package in the packaging call
itself. That holds for a malformed message too: redaction works on the member
name where it can, and otherwise falls back to the value shape, so a message
that never parses — an unquoted, single-quoted or double-encoded key value, or
a bare 32-hex token — does not leak the key either.

A job that asks for encryption fails explicitly, rather than producing
unencrypted output, when the installed Shaka Packager wrapper does not support
encryption or when the instance runs with `SKIP_PACKAGING=true`.

#### Environment variables

| Variable                      | Description                                                                                                                                                                                                                           | Default value            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `REDIS_URL`                   | URL to the redis server                                                                                                                                                                                                               | `redis://localhost:6379` |
| `REDIS_QUEUE`                 | Name of the redis queue to listen to                                                                                                                                                                                                  | `packaging-queue`        |
| `HOST`                        | Hostname or IP address to bind to for healtchechk endpoint                                                                                                                                                                            | `0.0.0.0`                |
| `PORT`                        | Port to bind to for healtchechk endpoint                                                                                                                                                                                              | `8000`                   |
| `DISABLE_HEALTCHECK`          | Disable the healthcheck endpoint                                                                                                                                                                                                      | `false`                  |
| `SHAKA_PACKAGER_EXECUTABLE`   | Path to the shaka packager executable                                                                                                                                                                                                 | `packager`               |
| `PACKAGE_OUTPUT_FOLDER`       | Base folder for output, actual output will be in a subfolder according to `OUTPUT_SUBFOLDER_TEMPLATE`. A trailing `/` is optional, it is added when missing                                                                           | `packaged`               |
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
| `TRIM_AAC_PRIMING_SAMPLES`    | Apply the post-packaging AAC priming workaround: remove the audio init edit list, drop the first audio sample, and shift later audio `tfdt` values by the removed priming sample duration                                             | `false`                  |
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
npm run start -- -r
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
