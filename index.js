'use strict';

const eejs = require('ep_etherpad-lite/node/eejs/');
// Compat: Etherpad 2.4+ uses ESM for Settings. Support both CJS and ESM.
const settingsModule = require('ep_etherpad-lite/node/utils/Settings');
const settings = settingsModule.default || settingsModule;
const { randomUUID } = require('crypto');
const path = require('path');
const url = require('url');

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

// Simple in-memory IP rate limiter
const _presignRateStore = new Map();
const PRESIGN_RATE_WINDOW_MS = 60 * 1000;   // 1 minute
const PRESIGN_RATE_MAX = 30;                // max 30 presigns per IP per min

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
    /* ------------------ Basic auth check ------------------ */
    const hasExpressSession = req.session && (req.session.user || req.session.authorId);
    const hasPadCookie = req.cookies && (req.cookies.sessionID || req.cookies.token);
    if (!hasExpressSession && !hasPadCookie) {
      return res.status(401).json({ error: 'Authentication required' });
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

      const { bucket, region, publicURL, expires } = storageCfg;
      if (!bucket || !region) {
        return res.status(500).json({ error: 'Invalid S3 configuration: missing bucket or region' });
      }

      const { padId } = req.params;
      const { name, type } = req.query;
      if (!name || !type) {
        return res.status(400).json({ error: 'Missing name or type query parameters' });
      }

      /* ------------- Extension allow-list ------------ */
      if (settings.ep_media_upload && settings.ep_media_upload.fileTypes && Array.isArray(settings.ep_media_upload.fileTypes)) {
        const allowedExts = settings.ep_media_upload.fileTypes;
        const extName = path.extname(name).replace('.', '').toLowerCase();
        if (!allowedExts.includes(extName)) {
          return res.status(400).json({ error: 'File type not allowed' });
        }
      }

      const ext = path.extname(name);
      const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
      const key = `${padId}/${randomUUID()}${safeExt}`;

      const s3Client = new S3Client({ region }); // credentials from env / IAM role

      const putCommand = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: type,
      });

      const signedUrl = await getSignedUrl(s3Client, putCommand, { expiresIn: expires || 600 });

      const basePublic = publicURL || `https://${bucket}.s3.${region}.amazonaws.com/`;
      const publicUrl = new url.URL(key, basePublic).toString();

      return res.json({ signedUrl, publicUrl });
    } catch (err) {
      logger.error('[ep_media_upload] S3 presign error', err);
      return res.status(500).json({ error: 'Failed to generate presigned URL' });
    }
  });
};

