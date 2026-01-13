# ep_media_upload

Etherpad plugin for secure file uploads via S3 presigned URLs.

**Requires:** `ep_hyperlinked_text`

## How It Works

1. User clicks paperclip button → selects file
2. Client uploads directly to S3 (server never handles file data)
3. Hyperlink inserted into document pointing to secure download endpoint
4. On click, Etherpad verifies access and redirects to short-lived S3 URL

**S3 bucket can be completely private** – downloads go through authenticated Etherpad endpoint.

## Configuration

### settings.json

```json
"ep_media_upload": {
  "storage": {
    "type": "s3_presigned",
    "region": "us-east-1",
    "bucket": "my-bucket-name",
    "keyPrefix": "uploads/",
    "expires": 900,
    "downloadExpires": 300
  },
  "fileTypes": ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "zip", "mp3", "mp4", "wav", "mov"],
  "maxFileSize": 52428800,
  "inlineExtensions": ["mp3", "mp4", "wav", "mov", "webm", "ogg"]
}
```

### Storage Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `type` | Yes | — | Must be `"s3_presigned"` |
| `region` | Yes | — | AWS region (e.g., `"us-east-1"`) |
| `bucket` | Yes | — | S3 bucket name |
| `keyPrefix` | No | `""` | Prefix for S3 keys (e.g., `"uploads/"`) |
| `expires` | No | `600` | Upload URL expiry in seconds (10 min) |
| `downloadExpires` | No | `300` | Download URL expiry in seconds (5 min) |

### Other Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `fileTypes` | No | all | Array of allowed extensions (without dots) |
| `maxFileSize` | No | unlimited | Max file size in bytes |
| `inlineExtensions` | No | `[]` | Extensions to open inline in browser (streaming). Files not in this list will download. |

### Environment Variables

```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

## S3 Setup

### Block Public Access

All four "Block Public Access" settings can be enabled since downloads go through Etherpad.

### CORS (for uploads)

```json
[{
  "AllowedOrigins": ["https://your-etherpad-domain.com"],
  "AllowedMethods": ["PUT"],
  "AllowedHeaders": ["Content-Type", "Content-Disposition"],
  "MaxAgeSeconds": 3000
}]
```

### IAM Permissions

- `s3:PutObject`
- `s3:GetObject`

## Security

- **Authentication**: All endpoints require valid Etherpad session
- **Fail-closed**: Requests denied if security module unavailable  
- **Rate limiting**: 30 requests/IP/minute
- **Input validation**: Path traversal protection on all parameters
- **Short-lived URLs**: Download links expire quickly (configurable)
- **Audit logging**: All uploads/downloads logged

## Dependencies

- `@aws-sdk/client-s3`
- `@aws-sdk/s3-request-presigner`
- `ep_etherpad-lite` >= 1.8.6
