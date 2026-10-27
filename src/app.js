const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const authRoutes = require('./modules/auth/auth.routes');
const groupRoutes = require('./modules/groups/group.routes');
const expenseRoutes = require('./modules/expenses/expense.routes');
const balanceRoutes = require('./modules/balances/balance.routes');
const settlementRoutes = require('./modules/settlements/settlement.routes');
const billRoutes = require('./modules/bills/bill.routes');
const receiptRoutes = require('./modules/receipts/receipt.routes');
const dashboardRoutes = require('./modules/dashboard/dashboard.routes');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Divvy API is running'
  });
});

app.get('/api/ready', async (req, res) => {
  try {
    if (req.app.locals.shuttingDown || mongoose.connection.readyState !== 1) throw new Error('Unavailable');
    await mongoose.connection.db.admin().ping({ timeoutMS: 2000 });
    if (req.app.locals.shuttingDown) throw new Error('Unavailable');
    res.status(200).json({ success: true, message: 'Divvy API is ready' });
  } catch {
    res.status(503).json({ success: false, message: 'Divvy API is not ready' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/invitations', require('./modules/groups/invitation.routes'));
app.use('/api/groups', groupRoutes);
app.use('/api/groups', expenseRoutes);
app.use('/api/groups', balanceRoutes);
app.use('/api/groups', settlementRoutes);
app.use('/api/groups', billRoutes);
app.use('/api/groups', dashboardRoutes);
app.use('/api/groups', receiptRoutes);

app.use('/api/expenses', expenseRoutes);
app.use('/api/bills', billRoutes);

module.exports = app;
