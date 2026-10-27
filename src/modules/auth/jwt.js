const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');

const generateToken = (userId, authVersion = 0) => {
  return jwt.sign(
    {
      userId, authVersion
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
      jwtid: randomUUID()
    }
  );
};

module.exports = {
  generateToken
};
