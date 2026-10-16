const Settlement = require('./Settlement');
const cents = value => Math.round(value * 100);
const userId = user => String(user._id || user);

// Keep purchase totals separate from repayments; use cents for net arithmetic.
const applySettlementPayments = async (groupId, balances) => {
  const payments = await Settlement.find({ groupId });
  const byUser = new Map(balances.map(balance => [userId(balance.user), balance]));
  for (const balance of balances) {
    balance.settlementPaid = 0;
    balance.settlementReceived = 0;
  }
  for (const payment of payments) {
    const sender = byUser.get(userId(payment.from));
    const recipient = byUser.get(userId(payment.to));
    if (sender) sender.settlementPaid += cents(payment.amount);
    if (recipient) recipient.settlementReceived += cents(payment.amount);
  }
  for (const balance of balances) {
    balance.net = (cents(balance.paid) - cents(balance.owed) +
      balance.settlementPaid - balance.settlementReceived) / 100;
    balance.settlementPaid /= 100;
    balance.settlementReceived /= 100;
  }
};

module.exports = { applySettlementPayments };
