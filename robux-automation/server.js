#!/usr/bin/env node

/**
 * Module dependencies.
 */

const app = require('./src/app');
const debug = require('debug')('robux-automation:server');
const http = require('http');
const { dbHelpers } = require('./src/models/db');
const { startGroupOrderPoller } = require('./src/services/group-order-poller');

// The in-process delivery sweep, for a machine that stays up.
//
// This file is not the entrypoint on Vercel — api/index.js is, and it does
// not start a poller: a serverless function is frozen the moment it sends a
// response, so an interval set here would simply never fire again. There, the
// schedule lives in vercel.json and calls /api/cron/group-orders instead.
startGroupOrderPoller(dbHelpers);

/**
 * Get port from environment and store in Express.
 */

const port = normalizePort(process.argv[2] || process.env.PORT || '3000');
app.set('port', port);

/**
 * Create HTTP server.
 */

const server = http.createServer(app);

/**
 * Listen on provided port, on all network interfaces.
 */

server.listen(port);
server.on('error', onError);
server.on('listening', onListening);

/**
 * Normalize a port into a number, string, or false.
 */

function normalizePort(val) {
  const port = parseInt(val, 10);

  if (isNaN(port)) {
    // named pipe
    return val;
  }

  if (port >= 0) {
    // port number
    return port;
  }

  return false;
}

/**
 * Event listener for HTTP server "error" event.
 */

function onError(error) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  const bind = typeof port === 'string'
    ? 'Pipe ' + port
    : 'Port ' + port;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

/**
 * Event listener for HTTP server "listening" event.
 */

function onListening() {
  const addr = server.address();
  const bind = typeof addr === 'string'
    ? 'pipe ' + addr
    : 'port ' + addr.port;
  debug('Listening on ' + bind);
  console.log('Robux Automation Server listening on ' + bind);
}