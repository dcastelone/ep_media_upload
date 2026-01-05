'use strict';

/**
 * ep_media_upload - Client-side hooks
 * 
 * Handles file selection, S3 upload via presigned URL, and hyperlink insertion
 * compatible with ep_hyperlinked_text.
 */

console.log('[ep_media_upload] Client hooks loaded');

// Store ace context for hyperlink insertion
let _aceContext = null;

/**
 * Modal management functions
 */
const showModal = (state = 'progress') => {
  const modal = $('#mediaUploadModal');
  const progressEl = $('#mediaUploadProgress');
  const successEl = $('#mediaUploadSuccess');
  const errorEl = $('#mediaUploadError');

  // Hide all states
  progressEl.hide();
  successEl.hide();
  errorEl.hide();

  // Show requested state
  if (state === 'progress') {
    progressEl.show();
  } else if (state === 'success') {
    successEl.show();
  } else if (state === 'error') {
    errorEl.show();
  }

  modal.addClass('visible');
};

const hideModal = () => {
  $('#mediaUploadModal').removeClass('visible');
};

const showError = (message) => {
  $('.ep-media-upload-error-text').text(message);
  showModal('error');
};

const showSuccess = () => {
  showModal('success');
  // Auto-hide after 1.5 seconds
  setTimeout(() => {
    hideModal();
  }, 1500);
};

/**
 * Validate file against configured restrictions
 */
const validateFile = (file) => {
  const config = clientVars.ep_media_upload || {};
  const errorTitle = html10n.get('ep_media_upload.error.title') || 'Upload Error';

  // Check file type
  if (config.fileTypes && Array.isArray(config.fileTypes)) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!config.fileTypes.includes(ext)) {
      const allowedTypes = config.fileTypes.join(', ');
      const errorMsg = html10n.get('ep_media_upload.error.fileType') || 'File type not allowed.';
      return { valid: false, error: `${errorMsg} Allowed: ${allowedTypes}` };
    }
  }

  // Check file size
  if (config.maxFileSize && file.size > config.maxFileSize) {
    const maxMB = (config.maxFileSize / (1024 * 1024)).toFixed(1);
    const errorMsg = html10n.get('ep_media_upload.error.fileSize', { maxallowed: maxMB }) 
      || `File is too large. Maximum size is ${maxMB} MB.`;
    return { valid: false, error: errorMsg };
  }

  return { valid: true };
};

/**
 * Upload file to S3 using presigned URL
 */
const uploadToS3 = async (file) => {
  // Step 1: Get presigned URL from server
  const queryParams = $.param({ name: file.name, type: file.type });
  const presignResponse = await $.getJSON(
    `${clientVars.padId}/pluginfw/ep_media_upload/s3_presign?${queryParams}`
  );

  if (!presignResponse || !presignResponse.signedUrl || !presignResponse.publicUrl) {
    throw new Error('Invalid presign response from server');
  }

  // Step 2: Upload directly to S3
  const uploadResponse = await fetch(presignResponse.signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });

  if (!uploadResponse.ok) {
    throw new Error(`S3 upload failed with status ${uploadResponse.status}`);
  }

  return presignResponse.publicUrl;
};

/**
 * Insert hyperlink at cursor position
 * Compatible with ep_hyperlinked_text format
 */
const doInsertMediaLink = function(url, linkText) {
  const editorInfo = this.editorInfo;
  const docMan = this.documentAttributeManager;
  const rep = editorInfo.ace_getRep();

  if (!editorInfo || !rep || !rep.selStart || !docMan || !url || !linkText) {
    console.error('[ep_media_upload] Missing context for hyperlink insertion');
    return;
  }

  const cursorPos = rep.selStart;
  const ZWSP = '\u200B'; // Zero-Width Space for boundary

  // Insert: ZWSP + linkText + ZWSP (same pattern as ep_hyperlinked_text)
  const textToInsert = ZWSP + linkText + ZWSP;
  editorInfo.ace_replaceRange(cursorPos, cursorPos, textToInsert);

  // Apply hyperlink attribute to the linkText portion (excluding ZWSPs)
  const linkStart = [cursorPos[0], cursorPos[1] + ZWSP.length];
  const linkEnd = [cursorPos[0], cursorPos[1] + ZWSP.length + linkText.length];

  docMan.setAttributesOnRange(linkStart, linkEnd, [['hyperlink', url]]);

  // Move cursor after the inserted content
  const finalPos = [cursorPos[0], cursorPos[1] + textToInsert.length];
  editorInfo.ace_performSelectionChange(finalPos, finalPos, false);

  console.log('[ep_media_upload] Inserted hyperlink:', linkText, '->', url);
};

/**
 * Handle file selection and upload
 */
const handleFileUpload = async (file, aceContext) => {
  // Validate file
  const validation = validateFile(file);
  if (!validation.valid) {
    showError(validation.error);
    return;
  }

  // Show progress modal
  showModal('progress');

  try {
    // Upload to S3
    const publicUrl = await uploadToS3(file);

    // Insert hyperlink into document
    aceContext.callWithAce((ace) => {
      ace.ace_doInsertMediaLink(publicUrl, file.name);
    }, 'insertMediaLink', true);

    // Show success
    showSuccess();

  } catch (err) {
    console.error('[ep_media_upload] Upload failed:', err);
    const errorMsg = html10n.get('ep_media_upload.error.uploadFailed') || 'Upload failed. Please try again.';
    showError(errorMsg);
  }
};

/**
 * aceInitialized hook
 * Bind the hyperlink insertion function to ace context
 */
exports.aceInitialized = (hook, context) => {
  context.editorInfo.ace_doInsertMediaLink = doInsertMediaLink.bind(context);
};

/**
 * postAceInit hook
 * Set up modal close button handler
 */
exports.postAceInit = (hook, context) => {
  _aceContext = context.ace;

  // Close button handler for error modal
  $(document).on('click', '#mediaUploadErrorClose', () => {
    hideModal();
  });

  // Click outside modal to close (only for error state)
  $(document).on('click', '#mediaUploadModal', (e) => {
    if (e.target.id === 'mediaUploadModal' && $('#mediaUploadError').is(':visible')) {
      hideModal();
    }
  });
};

/**
 * postToolbarInit hook
 * Register the mediaUpload toolbar command
 */
exports.postToolbarInit = (hook, context) => {
  const toolbar = context.toolbar;

  toolbar.registerCommand('mediaUpload', () => {
    // Remove any existing file input
    $('#mediaUploadFileInput').remove();

    // Create hidden file input
    const fileInput = $('<input>')
      .attr({
        type: 'file',
        id: 'mediaUploadFileInput',
        style: 'position:absolute;left:-9999px;'
      });

    // Add accept attribute if file types are configured
    if (clientVars.ep_media_upload && clientVars.ep_media_upload.fileTypes) {
      const accept = clientVars.ep_media_upload.fileTypes
        .map(ext => `.${ext}`)
        .join(',');
      fileInput.attr('accept', accept);
    }

    $('body').append(fileInput);

    // Handle file selection
    fileInput.on('change', (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) {
        return;
      }

      const file = files[0];
      handleFileUpload(file, context.ace);

      // Clean up file input
      fileInput.remove();
    });

    // Trigger file picker
    fileInput.trigger('click');
  });

  console.log('[ep_media_upload] Toolbar command registered');
};

