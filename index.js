'use strict';

const eejs = require('ep_etherpad-lite/node/eejs/');
// Compat: Etherpad 2.4+ uses ESM for Settings. Support both CJS and ESM.
const settingsModule = require('ep_etherpad-lite/node/utils/Settings');
const settings = settingsModule.default || settingsModule;
const { randomUUID } = require('crypto');
const path = require('path');
const url = require('url');

// Security Manager for pad access verification
let securityManager;
try {
  securityManager = require('ep_etherpad-lite/node/db/SecurityManager');
} catch (e) {
  console.warn('[ep_media_upload] SecurityManager not available');
}

// AWS SDK v3 for presigned URLs
let S3Client, PutObjectCommand, GetObjectCommand, getSignedUrl;
try {
  ({ S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3'));
  ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
} catch (e) {
  console.warn('[ep_media_upload] AWS SDK not installed; s3_presigned storage will not work.');
}

// Simple logger
const logger = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

// ============================================================================
// Rate Limiter with Periodic Cleanup
// ============================================================================
const _presignRateStore = new Map();
const PRESIGN_RATE_WINDOW_MS = 60 * 1000;   // 1 minute
const PRESIGN_RATE_MAX = 30;                // max 30 presigns per IP per min
const RATE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // cleanup every 5 minutes

// Periodic cleanup to prevent memory leak from stale IPs
setInterval(() => {
  const now = Date.now();
  for (const [ip, stamps] of _presignRateStore.entries()) {
    const validStamps = stamps.filter((t) => t > now - PRESIGN_RATE_WINDOW_MS);
    if (validStamps.length === 0) {
      _presignRateStore.delete(ip);
    } else {
      _presignRateStore.set(ip, validStamps);
    }
  }
}, RATE_CLEANUP_INTERVAL_MS).unref(); // unref() so it doesn't prevent process exit

// Utility: basic per-IP sliding-window rate limit
const _rateLimitCheck = (ip) => {
  const now = Date.now();
  let stamps = _presignRateStore.get(ip) || [];
  stamps = stamps.filter((t) => t > now - PRESIGN_RATE_WINDOW_MS);
  if (stamps.length >= PRESIGN_RATE_MAX) return false;
  stamps.push(now);
  _presignRateStore.set(ip, stamps);
  return true;
};

// ============================================================================
// Input Validation Helpers
// ============================================================================

/**
 * Validate padId to prevent path traversal and injection attacks.
 * Returns true if valid, false if invalid.
 * 
 * Etherpad pad IDs can contain various characters including:
 * - Alphanumeric, hyphens, underscores
 * - Dots and colons (common in pad names)
 * - $ (for group pads, e.g., g.xxxxxxxx$padName)
 * 
 * We use a blocklist approach to reject only dangerous patterns.
 */
const isValidPadId = (padId) => {
  if (!padId || typeof padId !== 'string') return false;
  if (padId.length === 0 || padId.length > 500) return false; // Reasonable length limits
  // Reject path traversal sequences
  if (padId.includes('..')) return false;
  // Reject null bytes
  if (padId.includes('\0')) return false;
  // Reject slashes (forward and back) to prevent path manipulation
  if (padId.includes('/') || padId.includes('\\')) return false;
  // Reject control characters (ASCII 0-31)
  if (/[\x00-\x1f]/.test(padId)) return false;
  return true;
};

/**
 * Validate filename extension.
 * Returns the extension (without dot, lowercase) or null if invalid.
 */
const getValidExtension = (filename) => {
  if (!filename || typeof filename !== 'string') return null;
  const ext = path.extname(filename);
  if (!ext || ext === '.') return null; // No extension or just a dot
  return ext.slice(1).toLowerCase(); // Remove leading dot
};

/**
 * MIME type to extension mapping for validation.
 * Maps file extensions to their valid MIME types.
 */
const EXTENSION_MIME_MAP = {
  // Documents
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  txt: ['text/plain'],
  rtf: ['application/rtf', 'text/rtf'],
  csv: ['text/csv', 'text/plain', 'application/csv'],
  
  // Images
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  bmp: ['image/bmp'],
  svg: ['image/svg+xml'],
  
  // Audio
  mp3: ['audio/mpeg', 'audio/mp3'],
  wav: ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave'],
  ogg: ['audio/ogg'],
  m4a: ['audio/mp4', 'audio/x-m4a'],
  flac: ['audio/flac'],
  
  // Video
  mp4: ['video/mp4'],
  mov: ['video/quicktime'],
  avi: ['video/x-msvideo'],
  mkv: ['video/x-matroska'],
  webm: ['video/webm'],
  
  // Archives
  zip: ['application/zip', 'application/x-zip-compressed'],
  rar: ['application/vnd.rar', 'application/x-rar-compressed'],
  '7z': ['application/x-7z-compressed'],
  tar: ['application/x-tar'],
  gz: ['application/gzip', 'application/x-gzip'],
};

/**
 * Validate that the MIME type matches the file extension.
 * Returns true if valid, false if mismatch detected.
 * If extension is not in our map, we allow it (permissive for unknown types).
 */
const isValidMimeForExtension = (extension, mimeType) => {
  if (!extension || !mimeType) return false;
  
  const allowedMimes = EXTENSION_MIME_MAP[extension.toLowerCase()];
  
  // If we don't have a mapping for this extension, allow any MIME type
  // (permissive approach for uncommon file types)
  if (!allowedMimes) return true;
  
  // Check if the provided MIME type matches any allowed MIME for this extension
  const normalizedMime = mimeType.toLowerCase().split(';')[0].trim(); // Handle "text/plain; charset=utf-8"
  return allowedMimes.some(allowed => allowed === normalizedMime);
};

/**
 * Validate file ID for download endpoint.
 * File ID format: UUID (with hyphens) + dot + extension
 * Example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf"
 * Returns true if valid, false if invalid.
 */
const isValidFileId = (fileId) => {
  if (!fileId || typeof fileId !== 'string') return false;
  if (fileId.length > 100) return false; // UUID (36) + dot (1) + extension (max ~10)
  // Reject path traversal and dangerous characters
  if (fileId.includes('..') || fileId.includes('/') || fileId.includes('\\')) return false;
  if (fileId.includes('\0')) return false;
  // Must match: UUID format (with hyphens) + dot + alphanumeric extension
  // UUID: 8-4-4-4-12 hex chars with hyphens = 36 chars
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-z0-9]+$/i.test(fileId)) return false;
  return true;
};

// ============================================================================
// Hooks
// ============================================================================

/**
 * loadSettings hook
 * Sync ep_media_upload config into the runtime Settings singleton
 */
exports.loadSettings = (hookName, args, cb) => {
  try {
    const runtimeSettings = settingsModule.default || settingsModule;
    if (args && args.settings && args.settings.ep_media_upload) {
      runtimeSettings.ep_media_upload = args.settings.ep_media_upload;
    }
  } catch (e) {
    console.warn('[ep_media_upload] Failed to sync settings:', e);
  }
  cb();
};

/**
 * clientVars hook
 * Exposes plugin settings to client code via clientVars
 */
exports.clientVars = (hookName, args, cb) => {
  const pluginSettings = {
    storageType: 's3_presigned',
  };

  if (!settings.ep_media_upload) {
    settings.ep_media_upload = {};
  }

  // Pass allowed file types
  if (settings.ep_media_upload.fileTypes) {
    pluginSettings.fileTypes = settings.ep_media_upload.fileTypes;
  }

  // Pass max file size
  if (settings.ep_media_upload.maxFileSize) {
    pluginSettings.maxFileSize = settings.ep_media_upload.maxFileSize;
  }

  return cb({ ep_media_upload: pluginSettings });
};

/**
 * eejsBlock_editbarMenuLeft hook
 * Inject toolbar button
 */
exports.eejsBlock_editbarMenuLeft = (hookName, args, cb) => {
  if (args.renderContext.isReadOnly) return cb();
  args.content += eejs.require('ep_media_upload/templates/uploadButton.ejs');
  return cb();
};

/**
 * eejsBlock_body hook
 * Inject modal HTML and CSS
 */
exports.eejsBlock_body = (hookName, args, cb) => {
  const modal = eejs.require('ep_media_upload/templates/uploadModal.ejs');
  args.content += modal;
  args.content += "<link href='../static/plugins/ep_media_upload/static/css/ep_media_upload.css' rel='stylesheet'>";
  return cb();
};

/**
 * expressCreateServer hook
 * Register the S3 presign and download endpoints
 */
exports.expressCreateServer = (hookName, context) => {
  logger.info('[ep_media_upload] Registering presign endpoint');

  // Route: GET /p/:padId/pluginfw/ep_media_upload/s3_presign
  context.app.get('/p/:padId/pluginfw/ep_media_upload/s3_presign', async (req, res) => {
    const { padId } = req.params;

    /* ------------------ Validate padId ------------------ */
    if (!isValidPadId(padId)) {
      return res.status(400).json({ error: 'Invalid pad ID' });
    }

    /* ------------------ Pad Access Verification ------------------ */
    // Use Etherpad's SecurityManager to verify user has access to this pad
    // SECURITY: Fail closed - if SecurityManager is unavailable, deny all requests
    if (!securityManager) {
      logger.error('[ep_media_upload] SECURITY: SecurityManager unavailable - denying upload request. This should not happen in a properly configured Etherpad instance.');
      return res.status(500).json({ error: 'Security module unavailable' });
    }

    // Get client IP for rate limiting and audit logging
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';

    let authorId = 'unknown';
    try {
      const sessionCookie = req.cookies?.sessionID || null;
      const token = req.cookies?.token || null;
      const user = req.session?.user || null;

      const accessResult = await securityManager.checkAccess(padId, sessionCookie, token, user);
      if (accessResult.accessStatus !== 'grant') {
        logger.warn(`[ep_media_upload] UPLOAD_DENIED: ip="${clientIp}" pad="${padId}" reason="access_denied"`);
        return res.status(403).json({ error: 'Access denied to this pad' });
      }
      authorId = accessResult.authorID || 'unknown';
    } catch (authErr) {
      logger.error('[ep_media_upload] Access check error:', authErr);
      return res.status(500).json({ error: 'Access verification failed' });
    }

    /* ------------------ Rate limiting --------------------- */
    if (!_rateLimitCheck(clientIp)) {
      logger.warn(`[ep_media_upload] UPLOAD_RATE_LIMITED: ip="${clientIp}" pad="${padId}"`);
      return res.status(429).json({ error: 'Too many presign requests' });
    }

    try {
      const storageCfg = settings.ep_media_upload && settings.ep_media_upload.storage;
      if (!storageCfg || storageCfg.type !== 's3_presigned') {
        return res.status(400).json({ error: 's3_presigned storage not configured' });
      }

      if (!S3Client || !PutObjectCommand || !getSignedUrl) {
        return res.status(500).json({ error: 'AWS SDK not available on server' });
      }

      const { bucket, region, expires, keyPrefix } = storageCfg;
      if (!bucket || !region) {
        return res.status(500).json({ error: 'Invalid S3 configuration: missing bucket or region' });
      }

      const { name, type } = req.query;
      if (!name || !type) {
        return res.status(400).json({ error: 'Missing name or type query parameters' });
      }

      /* ------------- Extension validation ------------ */
      const extName = getValidExtension(name);
      if (!extName) {
        return res.status(400).json({ error: 'Invalid filename: missing extension' });
      }

      /* ------------- Extension allow-list ------------ */
      if (settings.ep_media_upload && settings.ep_media_upload.fileTypes && Array.isArray(settings.ep_media_upload.fileTypes)) {
        const allowedExts = settings.ep_media_upload.fileTypes;
        if (!allowedExts.includes(extName)) {
          return res.status(400).json({ error: 'File type not allowed' });
        }
      }

      /* ------------- MIME type validation ------------ */
      // Prevent MIME type spoofing (e.g., uploading .txt with Content-Type: text/html)
      if (!isValidMimeForExtension(extName, type)) {
        logger.warn(`[ep_media_upload] MIME mismatch: ext=${extName}, type=${type}`);
        return res.status(400).json({ error: 'MIME type does not match file extension' });
      }

      // Build S3 key with optional prefix for path-based routing (e.g., CloudFront origins)
      const prefix = keyPrefix || '';
      const safeExt = `.${extName}`;
      const objectPath = `${padId}/${randomUUID()}${safeExt}`;  // e.g., "myPad/abc123.pdf"
      const key = `${prefix}${objectPath}`;                     // e.g., "uploads/myPad/abc123.pdf"

      const s3Client = new S3Client({ region }); // credentials from env / IAM role

      // Extract original filename for Content-Disposition header
      // This ensures files download with their original name instead of the UUID
      const originalFilename = path.basename(name);
      const safeFilename = originalFilename.replace(/[^\w\-_.]/g, '_'); // Sanitize for header
      const contentDisposition = `attachment; filename="${safeFilename}"`;

      const putCommand = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: type,
        // Force download instead of opening in browser
        ContentDisposition: contentDisposition,
      });

      const signedUrl = await getSignedUrl(s3Client, putCommand, { expiresIn: expires || 600 });

      // Build secure download URL (relative path that goes through our auth-protected endpoint)
      // Using query parameter for fileId to ensure Express 4/5 compatibility (path params don't handle dots well in Express 5)
      const fileId = path.basename(key); // e.g., "abc123-def456.pdf"
      const downloadUrl = `/p/${encodeURIComponent(padId)}/pluginfw/ep_media_upload/download?file=${encodeURIComponent(fileId)}`;

      // Log upload request for audit trail
      // Note: Never log tokens or session cookies - only non-sensitive identifiers
      const username = req.session?.user?.username || 'anonymous';
      logger.info(`[ep_media_upload] UPLOAD: author="${authorId}" user="${username}" ip="${clientIp}" pad="${padId}" file="${originalFilename}" s3key="${key}"`);

      // Return downloadUrl for hyperlink insertion (authenticated download endpoint)
      // Also return signedUrl for the actual S3 upload and contentDisposition for PUT headers
      return res.json({ signedUrl, downloadUrl, contentDisposition });
    } catch (err) {
      logger.error('[ep_media_upload] S3 presign error', err);
      return res.status(500).json({ error: 'Failed to generate presigned URL' });
    }
  });

  // ============================================================================
  // Download Endpoint - Secure file access via presigned GET URL redirect
  // ============================================================================
  // Route: GET /p/:padId/pluginfw/ep_media_upload/download?file=<fileId>
  // Using query parameter for fileId to ensure Express 4/5 compatibility
  logger.info('[ep_media_upload] Registering download endpoint');

  context.app.get('/p/:padId/pluginfw/ep_media_upload/download', async (req, res) => {
    const { padId } = req.params;
    const fileId = req.query.file;

    /* ------------------ Validate padId ------------------ */
    if (!isValidPadId(padId)) {
      return res.status(400).json({ error: 'Invalid pad ID' });
    }

    /* ------------------ Validate fileId ------------------ */
    if (!isValidFileId(fileId)) {
      return res.status(400).json({ error: 'Invalid file ID' });
    }

    /* ------------------ Pad Access Verification ------------------ */
    // Use Etherpad's SecurityManager to verify user has access to this pad
    // SECURITY: Fail closed - if SecurityManager is unavailable, deny all requests
    if (!securityManager) {
      logger.error('[ep_media_upload] SECURITY: SecurityManager unavailable - denying download request. This should not happen in a properly configured Etherpad instance.');
      return res.status(500).json({ error: 'Security module unavailable' });
    }

    // Get client IP for rate limiting and audit logging
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';

    let authorId = 'unknown';
    try {
      const sessionCookie = req.cookies?.sessionID || null;
      const token = req.cookies?.token || null;
      const user = req.session?.user || null;

      const accessResult = await securityManager.checkAccess(padId, sessionCookie, token, user);
      if (accessResult.accessStatus !== 'grant') {
        logger.warn(`[ep_media_upload] DOWNLOAD_DENIED: ip="${clientIp}" pad="${padId}" file="${fileId}" reason="access_denied"`);
        return res.status(403).json({ error: 'Access denied to this pad' });
      }
      authorId = accessResult.authorID || 'unknown';
    } catch (authErr) {
      logger.error('[ep_media_upload] Download access check error:', authErr);
      return res.status(500).json({ error: 'Access verification failed' });
    }

    /* ------------------ Rate limiting --------------------- */
    if (!_rateLimitCheck(clientIp)) {
      logger.warn(`[ep_media_upload] DOWNLOAD_RATE_LIMITED: ip="${clientIp}" pad="${padId}" file="${fileId}"`);
      return res.status(429).json({ error: 'Too many download requests' });
    }

    try {
      const storageCfg = settings.ep_media_upload && settings.ep_media_upload.storage;
      if (!storageCfg || storageCfg.type !== 's3_presigned') {
        return res.status(400).json({ error: 's3_presigned storage not configured' });
      }

      if (!S3Client || !GetObjectCommand || !getSignedUrl) {
        return res.status(500).json({ error: 'AWS SDK not available on server' });
      }

      const { bucket, region, keyPrefix, downloadExpires } = storageCfg;
      if (!bucket || !region) {
        return res.status(500).json({ error: 'Invalid S3 configuration: missing bucket or region' });
      }

      // Construct S3 key from padId and fileId
      // Key format: keyPrefix + padId + "/" + fileId
      // e.g., "uploads/myPad/abc123-def456.pdf"
      const prefix = keyPrefix || '';
      const key = `${prefix}${padId}/${fileId}`;

      // Extract file extension to determine inline vs attachment disposition
      const fileExtension = getValidExtension(fileId);
      
      // Get inlineExtensions from config (extensions that should open in browser)
      // Default behavior is download (attachment) for all files
      const inlineExtensions = settings.ep_media_upload?.inlineExtensions || [];
      const shouldOpenInline = fileExtension && 
        Array.isArray(inlineExtensions) && 
        inlineExtensions.map(e => e.toLowerCase()).includes(fileExtension.toLowerCase());

      // Determine Content-Disposition based on extension config
      // Extract filename for Content-Disposition header (UUID.ext -> use as filename)
      const filename = fileId.replace(/[^\w\-_.]/g, '_'); // Sanitize for header
      const disposition = shouldOpenInline 
        ? `inline; filename="${filename}"` 
        : `attachment; filename="${filename}"`;

      // Map extensions to canonical MIME types for consistent browser playback
      const EXTENSION_CONTENT_TYPE = {
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        webm: 'video/webm',
        ogg: 'audio/ogg',
        m4a: 'audio/mp4',
        pdf: 'application/pdf',
      };

      // Generate presigned GET URL with short expiry
      // Use ResponseContentDisposition and ResponseContentType to override stored headers
      const s3Client = new S3Client({ region });
      const commandParams = {
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: disposition,
      };

      // Set canonical Content-Type for inline extensions to ensure browser compatibility
      if (shouldOpenInline && fileExtension && EXTENSION_CONTENT_TYPE[fileExtension.toLowerCase()]) {
        commandParams.ResponseContentType = EXTENSION_CONTENT_TYPE[fileExtension.toLowerCase()];
      }

      const getCommand = new GetObjectCommand(commandParams);

      // Use downloadExpires from config, default to 300 seconds (5 minutes)
      const expiresIn = downloadExpires || 300;
      const presignedGetUrl = await getSignedUrl(s3Client, getCommand, { expiresIn });

      // Log download request for audit trail
      const username = req.session?.user?.username || 'anonymous';
      const dispositionType = shouldOpenInline ? 'inline' : 'attachment';
      logger.info(`[ep_media_upload] DOWNLOAD: author="${authorId}" user="${username}" ip="${clientIp}" pad="${padId}" file="${fileId}" disposition="${dispositionType}"`);

      // Redirect to the presigned URL
      return res.redirect(302, presignedGetUrl);

    } catch (err) {
      logger.error('[ep_media_upload] Download presign error:', err);
      
      // Check if this is a "NoSuchKey" error (file doesn't exist in S3)
      if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey') {
        return res.status(404).json({ error: 'File not found' });
      }
      
      return res.status(500).json({ error: 'Failed to generate download URL' });
    }
  });
};
