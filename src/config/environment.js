const jwt = require('jsonwebtoken');

function validateEnvironment(env = process.env) {
  if (!env.MONGO_URI || !/^mongodb(?:\+srv)?:\/\//.test(env.MONGO_URI)) {
    throw new Error('MONGO_URI must be a MongoDB connection URI.');
  }
  if (!env.JWT_SECRET || Buffer.byteLength(env.JWT_SECRET, 'utf8') < 32) {
    throw new Error('JWT_SECRET must contain at least 32 UTF-8 bytes.');
  }
  const lifetime = env.JWT_EXPIRES_IN || '7d';
  const decoded = jwt.decode(jwt.sign({}, env.JWT_SECRET, { expiresIn: lifetime }));
  if (!decoded.exp || decoded.exp <= decoded.iat) throw new Error('JWT_EXPIRES_IN must be a positive duration, such as 7d.');
  const port = Number(env.PORT || 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  return { port };
}

module.exports = { validateEnvironment };
