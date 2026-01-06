# ep_media_upload – BETA: Etherpad Media Upload Plugin

## Overview

A lightweight Etherpad plugin that adds file upload capability via an S3 presigned URL workflow. Upon successful upload, a hyperlink is inserted into the document using the same format as `ep_hyperlinked_text`. NOTE: this currently REQUIRES ep_hyperlinked_text to work.

**Key Security Feature:** Files are accessed through authenticated Etherpad endpoints, not direct S3 URLs. This allows S3 buckets to remain completely private while still enabling file downloads for authorized users.

---

## Features

### Toolbar Integration
- **Paperclip icon** button in the left editbar menu
- Button is **hidden in read-only mode** (uses `acl-write` class)
- Triggers native file picker dialog on click

### Upload Workflow
- **Client-side presigned URL pattern** (identical to ep_images_extended)
  1. Client requests presigned PUT URL from Etherpad server
  2. Server generates presigned URL using AWS SDK v3 (credentials from environment variables, not settings.json)
  3. Client uploads file directly to S3 (server never touches file)
  4. On success, client inserts hyperlink into document (pointing to authenticated download endpoint)
- **No base64 or local storage options** – S3 only
- **Scalable & secure**: Server only generates presigned URLs, no file handling

### Secure Download Workflow
- **Links point to authenticated Etherpad endpoint**, not direct S3 URLs
- When user clicks a file link:
  1. Request goes to `/p/:padId/pluginfw/ep_media_upload/download/:fileId`
  2. Server verifies user has access to the pad
  3. Server generates short-lived presigned GET URL (default 5 min)
  4. User is redirected (302) to the presigned URL
- **S3 bucket can be completely private** (Block Public Access enabled)

### File Restrictions
- **Allowed file types**: Configurable via `settings.json` (array of extensions without dots)
- **Maximum file size**: Configurable via `settings.json` (in bytes)

### Document Integration
- On upload success, inserts a **hyperlink** into the document
- **Link text**: Original filename (e.g., "quarterly-report.pdf")
- **Link URL**: Relative URL to authenticated download endpoint (e.g., `/p/myPad/pluginfw/ep_media_upload/download/uuid.pdf`)
- **Hyperlink format**: 100% compatible with `ep_hyperlinked_text` plugin
  - Uses `hyperlink` attribute with URL value
  - Renders as clickable `<a>` tag with `target="_blank"`

### Upload Feedback UI
- **Progress modal** during upload:
  - Shows "Uploading..." message
  - Basic visual indicator (e.g., spinner or progress text)
- **Success state**: Brief confirmation, then modal dismisses
- **Error state**: Shows error message with dismiss button
- Modal positioned center-screen (similar to ep_images_extended loader)

---

## Configuration (settings.json)

```jsonc
"ep_media_upload": {
  "storage": {
    "type": "s3_presigned",       // Only supported type
    "region": "us-east-1",        // AWS region
    "bucket": "my-bucket-name",   // S3 bucket name (can be private!)
    "keyPrefix": "uploads/",      // Optional S3 key prefix
    "expires": 900,               // Presigned PUT URL expiry in seconds (default 600)
    "downloadExpires": 300        // Presigned GET URL expiry in seconds (default 300)
  },
  "fileTypes": ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "mp3", "mp4", "wav", "mov", "zip", "txt"],
  "maxFileSize": 52428800         // 50 MB in bytes
}
```

### Storage Options Explained

| Option | Description |
|--------|-------------|
| `type` | Must be `"s3_presigned"` (only supported storage type) |
| `region` | AWS region (e.g., `"us-east-1"`) |
| `bucket` | S3 bucket name (can have Block Public Access enabled) |
| `keyPrefix` | Optional prefix for S3 keys (e.g., `"uploads/"` → keys become `uploads/padId/uuid.ext`) |
| `expires` | Presigned PUT URL expiry in seconds for uploads (default: 600) |
| `downloadExpires` | Presigned GET URL expiry in seconds for downloads (default: 300, shorter is more secure) |

**Minimal secure configuration:**
```jsonc
"storage": {
  "type": "s3_presigned",
  "region": "us-east-1",
  "bucket": "my-private-bucket",
  "keyPrefix": "etherpad-uploads/",
  "downloadExpires": 300          // 5 minute download links
}
```

### Environment Variables (AWS Credentials)
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN` (optional, for temporary credentials)

---

## File Structure

```
ep_media_upload/
├── ep.json                 # Plugin manifest (hooks registration)
├── index.js                # Server-side hooks (presign endpoint, clientVars)
├── package.json            # NPM package definition
├── locales/
│   └── en.json             # English translations
├── static/
│   ├── css/
│   │   └── ep_media_upload.css   # Modal styles
│   └── js/
│       └── clientHooks.js        # Client-side upload logic
└── templates/
    ├── uploadButton.ejs          # Toolbar button HTML
    └── uploadModal.ejs           # Progress/error modal HTML
```

---

## Hook Registration (ep.json)

### Client Hooks
- `postToolbarInit` – Register toolbar button command
- `postAceInit` – (Optional) Any initialization after editor ready

### Server Hooks
- `eejsBlock_editbarMenuLeft` – Inject toolbar button HTML
- `eejsBlock_body` – Inject modal HTML
- `expressConfigure` – Register endpoints:
  - `/p/:padId/pluginfw/ep_media_upload/s3_presign` (upload presign)
  - `/p/:padId/pluginfw/ep_media_upload/download/:fileId` (secure download)
- `clientVars` – Pass config to client (fileTypes, maxFileSize, storageType)
- `loadSettings` – Sync settings to runtime

---

## Server Endpoints

### Upload Presign Endpoint

**Route:**
```
GET /p/:padId/pluginfw/ep_media_upload/s3_presign?name=<filename>&type=<mimetype>
```

**Authentication:**
- Validates session via SecurityManager (cookie-based or express session)
- Rate limiting: Max 30 requests per IP per minute

**Response:**
```json
{
  "signedUrl": "https://bucket.s3.region.amazonaws.com/key?X-Amz-Signature=...",
  "downloadUrl": "/p/myPad/pluginfw/ep_media_upload/download/uuid.pdf",
  "contentDisposition": "attachment; filename=\"report.pdf\""
}
```

**Security:**
- PadId validation (path traversal protection)
- File extension validated against allowed `fileTypes`
- MIME type validation (prevents spoofing)
- Unique filename generated: `<keyPrefix><padId>/<uuid>.<ext>`

---

### Download Endpoint

**Route:**
```
GET /p/:padId/pluginfw/ep_media_upload/download?file=<fileId>
```

**Parameters:**
- `padId` - The pad ID (path parameter, validated for path traversal)
- `file` - UUID-based filename with extension as query param (e.g., `?file=abc123-def456.pdf`)

> **Note:** Using query parameter for the file ID ensures compatibility with both Express 4 and Express 5, as path parameters in Express 5 have stricter matching for file extensions.

**Authentication:**
- Validates session via SecurityManager (same as presign endpoint)
- Verifies user has access to the specific pad
- Rate limiting: Max 30 requests per IP per minute

**Response:**
- `302 Found` redirect to presigned S3 GET URL
- Presigned URL expires after `downloadExpires` seconds (default 300)

**Security:**
- FileId validated to prevent path traversal
- Pad access verification ensures only authorized users can download
- Short-lived presigned URLs minimize exposure if links are leaked
- Audit logging of all download requests

---

## Client Upload Flow

1. User clicks paperclip button
2. File picker opens (native `<input type="file">`)
3. User selects file
4. **Validation** (client-side):
   - Check file extension against `clientVars.ep_media_upload.fileTypes`
   - Check file size against `clientVars.ep_media_upload.maxFileSize`
   - Show error modal if validation fails
5. **Show upload modal** with "Uploading..." state
6. **Request presigned URL** from server
7. **PUT file to S3** using presigned URL
8. **On success**:
   - Show brief success message
   - Dismiss modal
   - Insert hyperlink at cursor position using `ace_doInsertMediaLink()`
9. **On failure**:
   - Show error message in modal
   - User dismisses manually

---

## Hyperlink Insertion

Uses the same mechanism as `ep_hyperlinked_text`:

```javascript
// Insert text with hyperlink attribute
const filename = file.name;  // e.g., "report.pdf"
const downloadUrl = "/p/myPad/pluginfw/ep_media_upload/download?file=abc123.pdf";

// Insert filename text at cursor
editorInfo.ace_replaceRange(cursorPos, cursorPos, filename);

// Apply hyperlink attribute to the inserted text
docMan.setAttributesOnRange(
  [cursorPos[0], cursorPos[1]],
  [cursorPos[0], cursorPos[1] + filename.length],
  [['hyperlink', downloadUrl]]
);
```

This ensures:
- Full compatibility with ep_hyperlinked_text rendering
- Clickable links that open in new tab
- **Authenticated access** – links go through Etherpad, not direct to S3
- Proper HTML export with `<a>` tags

---

## Error Handling

### Upload Errors

| Error | User Message |
|-------|--------------|
| Invalid file type | "File type not allowed. Allowed types: pdf, doc, ..." |
| File too large | "File is too large. Maximum size: 50 MB." |
| Presign request failed | "Upload failed. Please try again." |
| S3 upload failed | "Upload failed. Please try again." |
| Network error | "Network error. Please check your connection." |

### Download Errors

| HTTP Status | Error | Description |
|-------------|-------|-------------|
| 400 | Invalid pad ID / file ID | Malformed or potentially malicious input |
| 401 | Authentication required | No valid session cookies |
| 403 | Access denied to this pad | User doesn't have access to the pad |
| 404 | File not found | S3 object doesn't exist |
| 429 | Too many download requests | Rate limit exceeded |
| 500 | Failed to generate download URL | Server error |

---

## Compatibility Notes

- **Etherpad version**: Requires >= 1.8.6 (for ESM Settings module compatibility)
- **Node.js version**: >= 18.0.0
- **ep_hyperlinked_text**: **Required** – this plugin uses the `hyperlink` attribute which ep_hyperlinked_text renders as clickable links
- **Read-only pads**: Upload button automatically hidden

---

## Security Considerations

1. **Private S3 bucket**: Bucket can have Block Public Access enabled – files are accessed via authenticated endpoints
2. **No server-side file handling**: Files never touch the Etherpad server (upload/download via presigned URLs)
3. **Authentication required**: Both upload and download endpoints validate session via SecurityManager
4. **Pad access verification**: Download endpoint verifies user has access to the specific pad containing the file
5. **Short-lived download URLs**: Presigned GET URLs expire quickly (default 5 min) – leaked links become invalid
6. **Rate limiting**: Prevents abuse of both presign and download endpoints (30 req/IP/min)
7. **File type allowlist**: Only configured extensions accepted for upload
8. **Input validation**: PadId and FileId validated to prevent path traversal attacks
9. **Unique filenames**: UUIDs prevent enumeration/overwrites
10. **Audit logging**: All uploads and downloads are logged with user/pad/file info
11. **CORS on S3**: Bucket must allow PUT from pad origins (for uploads only)

---

## S3 Bucket Configuration

### Block Public Access (Recommended)

Since downloads go through the authenticated Etherpad endpoint, you can enable all Block Public Access settings:

1. Go to S3 bucket → Permissions → Block public access
2. Enable all four settings:
   - Block public access to buckets and objects granted through new ACLs
   - Block public access to buckets and objects granted through any ACLs
   - Block public access to buckets and objects granted through new public bucket policies
   - Block public and cross-account access to buckets and objects through any public bucket policies

### CORS Configuration

CORS is only needed for client-side uploads (PUT requests):

```json
[
  {
    "AllowedOrigins": ["https://your-etherpad-domain.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "Content-Disposition"],
    "MaxAgeSeconds": 3000
  }
]
```

### IAM Permissions

The IAM credentials need only:
- `s3:PutObject` (for uploads)
- `s3:GetObject` (for generating presigned download URLs)

---

## Dependencies

```json
{
  "dependencies": {
    "@aws-sdk/client-s3": "^3.555.0",
    "@aws-sdk/s3-request-presigner": "^3.555.0"
  },
  "peerDependencies": {
    "ep_etherpad-lite": ">=1.8.6"
  }
}
```

