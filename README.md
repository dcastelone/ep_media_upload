# ep_media_upload

Secure Etherpad attachments using direct-to-S3 uploads and short-lived, access-checked download redirects.

## Features

- Browser-to-S3 uploads through presigned PUT URLs
- Private S3 buckets with Block Public Access enabled
- Pad access checks on upload and download endpoints
- Configurable file types and size limits
- Inline or attachment download disposition by extension
- Rate limiting, input validation, and audit logging
- Hyperlink insertion through `ep_hyperlinked_text`

## Requirements

- Etherpad 3.3.2 or a later 3.x release
- `ep_hyperlinked_text` 0.2.5 or later
- An S3-compatible deployment using AWS Signature Version 4

Install the hyperlink plugin first, then install this package:

```sh
pnpm run plugins i ep_hyperlinked_text ep_media_upload
```

Restart Etherpad after installation.

## Configuration

```json
{
  "ep_media_upload": {
    "storage": {
      "type": "s3_presigned",
      "region": "us-east-1",
      "bucket": "example-attachments",
      "keyPrefix": "uploads/",
      "expires": 900,
      "downloadExpires": 300
    },
    "fileTypes": ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "zip", "mp3", "mp4", "wav", "mov"],
    "maxFileSize": 52428800,
    "inlineExtensions": ["mp3", "mp4", "wav", "mov", "webm", "ogg"]
  }
}
```

| Setting | Required | Default | Description |
| --- | --- | --- | --- |
| `storage.type` | Yes | — | Must be `s3_presigned` |
| `storage.region` | Yes | — | AWS region |
| `storage.bucket` | Yes | — | Private S3 bucket |
| `storage.keyPrefix` | No | Empty | Prefix applied to attachment object keys |
| `storage.expires` | No | 600 seconds | Presigned upload lifetime |
| `storage.downloadExpires` | No | 300 seconds | Presigned download lifetime |
| `fileTypes` | No | Any extension | Allowed filename extensions without dots |
| `maxFileSize` | No | Unlimited | Maximum file size in bytes |
| `inlineExtensions` | No | Empty | Extensions served with an inline disposition |

The AWS SDK uses its normal credential provider chain. On AWS, grant `s3:PutObject` and `s3:GetObject` through a task role instead of configuring long-lived credentials.

## S3 CORS

The bucket must allow PUT requests from the Etherpad origin. For example:

```json
[
  {
    "AllowedOrigins": ["https://pads.example.org"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "Content-Disposition"],
    "MaxAgeSeconds": 3000
  }
]
```

Downloads are requested through an authenticated Etherpad route and redirected to a short-lived S3 URL. The S3 bucket does not need public read access.

## Export support

The plugin inserts ordinary hyperlink attributes. It does not embed attachment bytes into HTML or document exports.

## Development

```sh
pnpm install --frozen-lockfile
pnpm test
```

Licensed under the Apache License 2.0.
