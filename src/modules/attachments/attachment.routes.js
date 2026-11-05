const multer = require('multer');
const GroupMember = require('../groups/GroupMember');
const { detectMime } = require('../receipts/receipt.upload');

const maxBytes = 3 * 1024 * 1024;
const types = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxBytes, files: 1, fields: 0 },
}).single('attachment');

const fail = (res, status, message) => res.status(status).json({ success: false, message });

function readAttachment(req, res, next) {
  upload(req, res, error => {
    if (error?.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'Attachments must be 3 MB or smaller.');
    if (error || !req.file?.size) return fail(res, 400, 'Upload one attachment.');
    if (!types.has(req.file.mimetype) || detectMime(req.file.buffer) !== req.file.mimetype) {
      return fail(res, 415, 'Choose a JPEG, PNG, WebP, or PDF file.');
    }
    next();
  });
}

function registerAttachments(router, Model, param, protect, recordGroup) {
  const path = `/:${param}/attachment`;

  async function authorize(req, res, next) {
    try {
      if (!req.group) return fail(res, 404, 'Record not found.');
      const membership = await GroupMember.findOne({
        groupId: req.group._id, userId: req.user._id, status: 'ACTIVE',
      }).select('role');
      if (!membership) return fail(res, 403, 'You do not have access to this group.');
      req.attachmentScope = { _id: req.params[param], groupId: req.group._id };
      req.attachmentOwner = membership.role === 'OWNER';
      res.set('Cache-Control', 'private, no-store');
      next();
    } catch {
      return fail(res, 503, 'Could not check attachment access.');
    }
  }

  function metadata(req, attachment) {
    return {
      attachment: attachment ? { name: attachment.name, size: attachment.size } : null,
      canManage: !attachment || req.attachmentOwner ||
        String(attachment.uploadedBy) === String(req.user._id),
    };
  }

  router.get(path, protect, recordGroup, authorize, async (req, res) => {
    try {
      const record = await Model.findOne(req.attachmentScope).select('attachment').lean();
      if (!record) return fail(res, 404, 'Record not found.');
      return res.json({ success: true, data: metadata(req, record.attachment) });
    } catch {
      return fail(res, 503, 'Could not load the attachment.');
    }
  });

  router.get(`${path}/download`, protect, recordGroup, authorize, async (req, res) => {
    try {
      const record = await Model.findOne(req.attachmentScope).select('attachment +attachmentBytes');
      if (!record?.attachment || !record.attachmentBytes) return fail(res, 404, 'No attachment found.');
      res.attachment(record.attachment.name);
      res.set('Content-Type', record.attachment.mime);
      res.set('X-Content-Type-Options', 'nosniff');
      return res.send(record.attachmentBytes);
    } catch {
      return fail(res, 503, 'Could not download the attachment.');
    }
  });

  async function change(req, res) {
    const file = req.file;
    const attachment = file ? {
      name: file.originalname.replace(/[\\/\x00-\x1f\x7f]/g, '_').trim().slice(0, 180) || 'attachment',
      mime: file.mimetype,
      size: file.size,
      uploadedBy: req.user._id,
    } : null;

    const filter = { ...req.attachmentScope };
    if (!req.attachmentOwner) {
      filter.$or = [{ attachment: null }, { 'attachment.uploadedBy': req.user._id }];
    }
    try {
      const record = await Model.findOneAndUpdate(
        filter,
        file ? { $set: { attachment, attachmentBytes: file.buffer } } :
          { $unset: { attachment: 1, attachmentBytes: 1 } },
        { returnDocument: 'after', timestamps: false },
      ).select('attachment').lean();
      if (!record) return fail(res, 409, 'The attachment changed or you cannot manage it. Refresh and try again.');
      return res.json({ success: true, data: metadata(req, record.attachment) });
    } catch {
      return fail(res, 503, 'Could not save the attachment. Please try again.');
    }
  }

  router.put(path, protect, recordGroup, authorize, readAttachment, change);
  router.delete(path, protect, recordGroup, authorize, change);
}

module.exports = { registerAttachments };
