// Responsible for: database connection and starting the server

require('dotenv').config();

const app = require('./src/app');
const connectDatabase = require('./src/config/database');

const { startRecurringExpenseWorker } = require('./src/modules/expenses/expense.recurrence');

const { startRecurringBillWorker } = require('./src/modules/bills/bill.recurrence');

const mongoose = require('mongoose');
const { validateEnvironment } = require('./src/config/environment');

const startServer = async () => {
  const { port } = validateEnvironment();
  await connectDatabase();

  const stopWorker = await startRecurringBillWorker();
  const stopExpenseWorker = await startRecurringExpenseWorker();

  const server = app.listen(port);
  server.once('listening', () => {
    console.log(`Server running on port ${port}`);
  });
  server.on('error', error => {
    console.error('HTTP server failed:', error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Stop the existing server or choose a different PORT.`
      : error.code || error.name);
    process.exit(1);
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.locals.shuttingDown = true;
    stopWorker();
    stopExpenseWorker();
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(async () => {
      try {
        await mongoose.disconnect();
        clearTimeout(deadline);
        process.exit(0);
      } catch {
        process.exit(1);
      }
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
};

startServer().catch(error => {
  console.error('Server startup failed:', error.message);
  process.exit(1);
});
