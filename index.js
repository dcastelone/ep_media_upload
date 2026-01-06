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
let S3Client, PutObjectCommand, getSignedUrl;
try {
  ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
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
  wav: ['audio/wav', 'audio/wave', 'audio/x-wav'],
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
 * expressConfigure hook
 * Register the S3 presign endpoint
 */
exports.expressConfigure = (hookName, context) => {
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
    if (securityManager) {
      try {
        const sessionCookie = req.cookies?.sessionID || null;
        const token = req.cookies?.token || null;
        const user = req.session?.user || null;

        const accessResult = await securityManager.checkAccess(padId, sessionCookie, token, user);
        if (accessResult.accessStatus !== 'grant') {
          return res.status(403).json({ error: 'Access denied to this pad' });
        }
      } catch (authErr) {
        logger.error('[ep_media_upload] Access check error:', authErr);
        return res.status(500).json({ error: 'Access verification failed' });
      }
    } else {
      // Fallback: basic cookie check if SecurityManager unavailable
      const hasExpressSession = req.session && (req.session.user || req.session.authorId);
      const hasPadCookie = req.cookies && (req.cookies.sessionID || req.cookies.token);
      if (!hasExpressSession && !hasPadCookie) {
        return res.status(401).json({ error: 'Authentication required' });
      }
    }

    /* ------------------ Rate limiting --------------------- */
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    if (!_rateLimitCheck(ip)) {
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

      const { bucket, region, publicURL, expires, keyPrefix } = storageCfg;
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

      // Build public URL:
      // - If custom publicURL is set (e.g., CDN), it already includes the prefix path
      // - If no publicURL, use direct S3 URL with full key
      let publicUrl;
      if (publicURL) {
        publicUrl = new url.URL(objectPath, publicURL).toString();
      } else {
        const s3Base = `https://${bucket}.s3.${region}.amazonaws.com/`;
        publicUrl = new url.URL(key, s3Base).toString();
      }

      // Log upload request for audit trail
      // Note: Never log tokens or session cookies - only non-sensitive identifiers
      const userId = req.session?.user?.username || req.session?.authorId || 'anonymous';
      logger.info(`[ep_media_upload] UPLOAD: user="${userId}" pad="${padId}" file="${originalFilename}" s3key="${key}"`);

      // Return contentDisposition so client can include it in the PUT request
      // (required because it's part of the presigned URL signature)
      return res.json({ signedUrl, publicUrl, contentDisposition });
    } catch (err) {
      logger.error('[ep_media_upload] S3 presign error', err);
      return res.status(500).json({ error: 'Failed to generate presigned URL' });
    }
  });
};
