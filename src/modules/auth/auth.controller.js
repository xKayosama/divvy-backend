const bcrypt = require('bcryptjs');
const User = require('../users/User');
const { generateToken } = require('./jwt');
const RevokedToken = require('./RevokedToken');

const register = async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body || {};

    if (![firstName, lastName, email, password].every(value => typeof value === 'string') ||
        !firstName.trim() || !lastName.trim() || firstName.length > 100 || lastName.length > 100 ||
        email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
        password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ success: false, message: 'Provide valid names and email, and a password of at least 8 characters and at most 72 UTF-8 bytes.' });
    }

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, email, and password are required.'
      });
    }

    const existingUser = await User.findOne({
      email: email.trim().toLowerCase()
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await User.create({
      firstName,
      lastName,
      email: email.trim().toLowerCase(),
      password: hashedPassword
    });

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      data: {
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email
        }
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    }
    console.error('Register error:', error);

    return res.status(500).json({
      success: false,
      message: 'Something went wrong while creating your account.'
    });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (typeof email !== 'string' || typeof password !== 'string' ||
        !email.trim() || email.length > 254 || !password || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ success: false, message: 'Provide a valid email and password.' });
    }

    // Validate fields
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.'
      });
    }

    // Find user
    const user = await User.findOne({
      email: email.trim().toLowerCase()
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }

    // Compare password
    const isPasswordValid = await bcrypt.compare(
      password,
      user.password
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }

    // Generate JWT
    const token = generateToken(user._id.toString());

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      data: {
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role
        }
      }
    });
  } catch (error) {
    console.error('Login error:', error);

    return res.status(500).json({
      success: false,
      message: 'Something went wrong while logging in.'
    });
  }
};

const logout = async (req, res) => {
  try {
    await RevokedToken.updateOne(
      { tokenHash: req.auth.tokenHash },
      { $setOnInsert: { expiresAt: req.auth.expiresAt } },
      { upsert: true }
    );

    return res.status(200).json({
      code:200,
      success: true,
      message: 'Logout successful.'
    });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({
      code:500,
      success: false,
      message: 'Something went wrong while logging out.'
    });
  }
};

const getMe = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      user: {
        id: req.user._id,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        email: req.user.email,
        role: req.user.role
      }
    }
  });
};

module.exports = {
  register,
  login,
  logout,
  getMe
};
