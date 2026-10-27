const jwt = require('jsonwebtoken');
const User = require('../users/User');
const RevokedToken = require('./RevokedToken');
const { hashToken } = require('./tokenHash');

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.'
      });
    }

    const token = authHeader.split(' ')[1];

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    const tokenHash = hashToken(token);
    if (await RevokedToken.exists({ tokenHash })) {
      return res.status(401).json({
        success: false,
        message: 'Token has been logged out.'
      });
    }

    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User no longer exists.'
      });
    }

    if ((decoded.authVersion || 0) !== (user.authVersion || 0)) {
      return res.status(401).json({ success: false, message: 'Your password changed. Please sign in again.' });
    }

    req.user = user;
    req.auth = { tokenHash, expiresAt: new Date(decoded.exp * 1000) };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token.'
    });
  }
};

module.exports = {
  protect
};
