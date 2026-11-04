const { randomUUID } = require('node:crypto');
const { v2: cloudinary } = require('cloudinary');
const multer = require('multer');
const User = require('../users/User');
const { detectMime } = require('../receipts/receipt.upload');
const { accountFilter, present } = require('./profile.controller');

const maxBytes = 5 * 1024 * 1024;
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxBytes, files: 1, fields: 0 },
}).single('avatar');

function readAvatar(req, res, next) {
  upload(req, res, error => {
    if (error?.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'Profile photos must be 5 MB or smaller.');
    if (error || !req.file?.size) return fail(res, 400, 'Upload one profile photo.');
    const mime = detectMime(req.file.buffer);
    if (!imageTypes.has(mime) || mime !== req.file.mimetype) {
      return fail(res, 415, 'Choose a JPEG, PNG, or WebP image.');
    }
    next();
  });
}

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function isConfigured() {
  const { cloud_name, api_key, api_secret } = cloudinary.config();
  return Boolean(cloud_name && api_key && api_secret);
}

async function destroyAvatar(publicId) {
  if (!publicId) return;
  if (!isConfigured()) throw new Error('Avatar storage is unavailable');
  const { result } = await cloudinary.uploader.destroy(publicId, { invalidate: true });
  if (result !== 'ok' && result !== 'not found') throw new Error('Avatar cleanup failed');
}

async function discardAvatar(publicId) {
  try {
    await destroyAvatar(publicId);
  } catch {
    console.error('Could not clean up Cloudinary avatar:', publicId);
  }
}

function uploadAvatar(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      public_id: publicId,
      resource_type: 'image',
      overwrite: false,
      transformation: [{ width: 256, height: 256, crop: 'fill', gravity: 'auto' }],
      format: 'webp',
    }, (error, result) => error ? reject(error) : resolve(result));
    stream.on('error', reject);
    stream.end(buffer);
  });
}

async function changeAvatar(req, res) {
  const file = req.file;
  if ((file || req.user.avatarPublicId) && !isConfigured()) {
    return fail(res, 503, 'Profile photo storage is temporarily unavailable.');
  }

  const publicId = file ? `divvy/avatars/${randomUUID()}` : null;
  let avatar = null;
  if (file) {
    try {
      const result = await uploadAvatar(file.buffer, publicId);
      avatar = result.secure_url;
    } catch (error) {
      await discardAvatar(publicId);
      return error?.http_code === 400
        ? fail(res, 422, 'This image could not be read. Choose a different photo.')
        : fail(res, 503, 'Could not upload your profile photo. Please try again.');
    }
  }

  let user;
  try {
    user = await User.findOneAndUpdate(
      { ...accountFilter(req), avatarPublicId: req.user.avatarPublicId ?? null },
      { $set: { avatar, avatarPublicId: publicId } },
      { returnDocument: 'after', runValidators: true },
    );
  } catch {
    // The write may have reached MongoDB. Verify before deleting the new asset.
    if (publicId) {
      try {
        if (!await User.exists({ _id: req.user._id, avatarPublicId: publicId })) {
          await discardAvatar(publicId);
        }
      } catch {
        console.error('Could not verify Cloudinary avatar state:', publicId);
      }
    }
    return fail(res, 503, 'Could not save your profile photo. Please try again.');
  }

  if (!user) {
    await discardAvatar(publicId);
    return fail(res, 409, 'Your profile changed. Reload and try again.');
  }

  await discardAvatar(req.user.avatarPublicId);
  return res.json({ success: true, data: { user: present(user) } });
}

module.exports = { readAvatar, changeAvatar, destroyAvatar };
