'use strict';

const runtime = require('./production-server');

if (require.main === module) {
  runtime.installShutdownHandlers();
  runtime.startServer().catch(async (error) => {
    console.error('Zenith startup failed:', error.message);
    try { await runtime.shutdown(); } catch (closeError) { console.error('Shutdown failed:', closeError.message); }
    process.exitCode = 1;
  });
}

module.exports = runtime;