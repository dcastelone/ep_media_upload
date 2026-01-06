# ep_media_upload – BETA: Etherpad Media Upload Plugin

## Overview

A lightweight Etherpad plugin that adds file upload capability via an S3 presigned URL workflow. Upon successful upload, a hyperlink is inserted into the document using the same format as `ep_hyperlinked_text`. NOTE: this currently REQUIRES ep_hyperlinked_text to work.

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
  4. On success, client inserts hyperlink into document
- **No base64 or local storage options** – S3 only
- **Scalable & secure**: Server only generates presigned URLs, no file handling

### File Restrictions
- **Allowed file types**: Configurable via `settings.json` (array of extensions without dots)
- **Maximum file size**: Configurable via `settings.json` (in bytes)

### Document Integration
- On upload success, inserts a **hyperlink** into the document
- **Link text**: Original filename (e.g., "quarterly-report.pdf")
- **Link URL**: S3 public/CDN URL for direct download
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
    "bucket": "my-bucket-name",   // S3 bucket name
    "keyPrefix": "uploads/",      // Optional S3 key prefix (for CloudFront path-based routing)
    "publicURL": "https://cdn.example.com/uploads/",  // Optional CDN URL (should include prefix if using keyPrefix)
    "expires": 900                // Presigned URL expiry in seconds (default 600)
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
| `bucket` | S3 bucket name |
| `keyPrefix` | Optional prefix for S3 keys (e.g., `"uploads/"` → keys become `uploads/padId/uuid.ext`) |
| `publicURL` | Optional CDN/custom URL base. If using `keyPrefix`, include it in this URL. |
| `expires` | Presigned URL expiry in seconds (default: 600) |

**Example with CloudFront path-based routing:**
```jsonc
"storage": {
  "type": "s3_presigned",
  "region": "us-east-1",
  "bucket": "my-bucket",
  "keyPrefix": "uploads/",                              // S3 key: uploads/padId/uuid.pdf
  "publicURL": "https://d123.cloudfront.net/uploads/"   // Public URL includes prefix
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
- `expressConfigure` – Register `/p/:padId/pluginfw/ep_media_upload/s3_presign` endpoint
- `clientVars` – Pass config to client (fileTypes, maxFileSize, storageType)
- `loadSettings` – Sync settings to runtime

---

## Server Endpoint: Presign

### Route
```
GET /p/:padId/pluginfw/ep_media_upload/s3_presign?name=<filename>&type=<mimetype>
```

### Authentication
- Validates session (cookie-based or express session)
- Rate limiting: Max 30 requests per IP per minute (configurable)

### Response
```json
{
  "signedUrl": "https://bucket.s3.region.amazonaws.com/padId/uuid.ext?...",
  "publicUrl": "https://cdn.example.com/padId/uuid.ext"
}
```

### Security
- File extension validated against allowed `fileTypes`
- Unique filename generated: `<padId>/<uuid>.<ext>`
- MIME type passed to S3 for proper Content-Type header

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
const url = publicUrl;       // e.g., "https://cdn.example.com/padId/abc123.pdf"

// Insert filename text at cursor
editorInfo.ace_replaceRange(cursorPos, cursorPos, filename);

// Apply hyperlink attribute to the inserted text
docMan.setAttributesOnRange(
  [cursorPos[0], cursorPos[1]],
  [cursorPos[0], cursorPos[1] + filename.length],
  [['hyperlink', url]]
);
```

This ensures:
- Full compatibility with ep_hyperlinked_text rendering
- Clickable links that open in new tab
- Proper HTML export with `<a>` tags

---

## Error Handling

| Error | User Message |
|-------|--------------|
| Invalid file type | "File type not allowed. Allowed types: pdf, doc, ..." |
| File too large | "File is too large. Maximum size: 50 MB." |
| Presign request failed | "Upload failed. Please try again." |
| S3 upload failed | "Upload failed. Please try again." |
| Network error | "Network error. Please check your connection." |

---

## Compatibility Notes

- **Etherpad version**: Requires >= 1.8.6 (for ESM Settings module compatibility)
- **Node.js version**: >= 18.0.0
- **ep_hyperlinked_text**: **Required** – this plugin uses the `hyperlink` attribute which ep_hyperlinked_text renders as clickable links
- **Read-only pads**: Upload button automatically hidden

---

## Security Considerations

1. **No server-side file handling**: Files never touch the Etherpad server
2. **Authentication required**: Presign endpoint validates session
3. **Rate limiting**: Prevents presign endpoint abuse
4. **File type allowlist**: Only configured extensions accepted
5. **Unique filenames**: UUIDs prevent enumeration/overwrites
6. **CORS on S3**: Bucket must allow PUT from pad origins

---

## S3 Bucket CORS Configuration

Required CORS policy for the S3 bucket:

```json
[
  {
    "AllowedOrigins": ["https://your-etherpad-domain.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3000
  }
]
```

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

