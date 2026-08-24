// A sqlite3-shaped facade over a Postgres connection.
//
// Every repository in this project was written against node-sqlite3's
// callback API: db.run/get/all(sql, params, cb), `?` placeholders, and a
// `this.lastID` / `this.changes` context on run()'s callback. There are ~95
// helpers across 17 repositories written that way.
//
// Rewriting all of them into async/await pg calls would have touched every
// data-layer file and every caller. Instead the *connection* changes shape
// and the repositories do not: this module speaks the sqlite3 API on the
// outside and Postgres on the inside. The seam db.js already established —
// repositories are factories that receive a connection — is what makes that
// possible.
//
// What it translates:
//   ?           -> $1, $2, ...    positional placeholders
//   this.lastID -> RETURNING id   appended to INSERTs that lack RETURNING
//   this.changes -> result.rowCount
//   serialize() -> a sequential queue (see below)
//
// What it deliberately does NOT translate: SQL dialect. AUTOINCREMENT,
// datetime('now'), PRAGMA and friends were converted in the schema and
// repository files themselves, because a regex rewriting SQL on every query
// is a bug factory and hides what is actually being run.

// sqlite3 numbers `?` left to right; Postgres wants $1..$n. A `?` inside a
// string literal is not a placeholder, so quoted spans are skipped.
function toPositional(sql) {
  let out = '';
  let index = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];

    if (inSingle) {
      out += char;
      // '' inside a single-quoted literal is an escaped quote, not the end.
      if (char === "'") {
        if (sql[i + 1] === "'") {
          out += sql[i + 1];
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }

    if (inDouble) {
      out += char;
      if (char === '"') inDouble = false;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      out += char;
      continue;
    }

    if (char === '"') {
      inDouble = true;
      out += char;
      continue;
    }

    if (char === '?') {
      index += 1;
      out += '$' + index;
      continue;
    }

    out += char;
  }

  return out;
}

const INSERT = /^\s*insert\s+into/i;
const HAS_RETURNING = /\breturning\b/i;

// Tables whose primary key is not named `id`. Appending RETURNING id to an
// insert on these would error, and nothing reads lastID for them anyway.
const NO_ID_COLUMN = new Set(['settings', 'express_sessions', 'sessions', 'group_memberships']);

function insertTarget(sql) {
  const match = /^\s*insert\s+into\s+"?([a-z_][a-z0-9_]*)"?/i.exec(sql);
  return match ? match[1].toLowerCase() : null;
}

// run()'s callback reads `this.lastID` on inserts. Postgres only reports a
// generated key if the statement asks for it, so an INSERT that does not
// already end in RETURNING gets `RETURNING id` appended.
//
// ON CONFLICT DO NOTHING that hits a conflict returns no row at all — that is
// the correct signal, and callers read it as `inserted: changes > 0`.
function shouldReturnId(sql) {
  if (!INSERT.test(sql) || HAS_RETURNING.test(sql)) return false;
  const table = insertTarget(sql);
  return table !== null && !NO_ID_COLUMN.has(table);
}

function withReturning(sql) {
  return sql.replace(/;\s*$/, '') + ' RETURNING id';
}

// Bare transaction control is a trap over a connection pool: every statement
// is checked out independently, so BEGIN, the work, and COMMIT can each land
// on a different backend. The transaction then guards nothing, the COMMIT
// closes an empty one, and — worst of all — none of it errors.
//
// Under sqlite3 this worked, because there was only ever one connection. The
// one caller that relied on it (reorderBankAccounts) is now a single atomic
// statement instead. This check is here so the next one fails loudly at the
// call site rather than silently losing its atomicity in production.
//
// A block that genuinely needs several statements to be atomic should use
// db.client to check out one connection and drive it directly.
const TRANSACTION_CONTROL = /^\s*(begin|commit|rollback|savepoint|start\s+transaction)\b/i;

/**
 * Wraps a pg-compatible client (node-postgres Pool, or PGlite) in the
 * sqlite3 Database surface the repositories expect.
 *
 * @param {{query: (sql: string, params: any[]) => Promise<{rows: any[], rowCount: number}>}} client
 * @param {() => Promise<void>} [close]
 */
function createAdapter(client, close) {
  // sqlite3's serialize() guarantees statements queued inside it run in
  // order. The schema layer depends on that: CREATE TABLE must land before
  // the INSERT that seeds it. Postgres over a pool has no such ordering, so
  // every statement goes through one promise chain and runs strictly in the
  // order it was queued. This costs concurrency the app was never using —
  // the sqlite3 driver serialized everything through one connection anyway.
  let queue = Promise.resolve();

  function enqueue(task) {
    const result = queue.then(task, task);
    // A rejected task must not poison the chain for every later statement.
    queue = result.then(function () {}, function () {});
    return result;
  }

  // sqlite3 lets params be omitted: db.run(sql, cb).
  function normalize(params, callback) {
    if (typeof params === 'function') return { params: [], callback: params };
    return {
      params: params === undefined || params === null ? [] : params,
      callback: callback
    };
  }

  function execute(sql, params) {
    if (TRANSACTION_CONTROL.test(sql)) {
      return Promise.reject(new Error(
        'Transaction control (' + sql.trim().split(/\s+/)[0].toUpperCase() + ') is not safe on a '
        + 'pooled connection — each statement may run on a different backend. Use a single '
        + 'atomic statement, or check out one client via db.client.'
      ));
    }
    return enqueue(function () {
      return client.query(toPositional(sql), params);
    });
  }

  const db = {
    // The underlying pg client, for the rare caller that needs real
    // transactions or Postgres-only features.
    client: client,

    run(sql, params, callback) {
      const call = normalize(params, callback);
      const text = shouldReturnId(sql) ? withReturning(sql) : sql;

      execute(text, call.params).then(
        function (result) {
          if (!call.callback) return;
          // sqlite3 invokes run()'s callback with the Statement as `this`,
          // which is where lastID and changes live. Every caller in this
          // project reads them that way, so the context is reproduced.
          const context = {
            lastID: result.rows && result.rows[0] ? result.rows[0].id : undefined,
            changes: result.rowCount == null ? 0 : result.rowCount
          };
          call.callback.call(context, null);
        },
        function (error) {
          if (!call.callback) {
            console.error('DB run error:', error.message, '\n  SQL:', sql);
            return;
          }
          call.callback.call({ lastID: undefined, changes: 0 }, error);
        }
      );
      return db;
    },

    get(sql, params, callback) {
      const call = normalize(params, callback);
      execute(sql, call.params).then(
        function (result) { if (call.callback) call.callback(null, result.rows[0]); },
        function (error) { if (call.callback) call.callback(error); }
      );
      return db;
    },

    all(sql, params, callback) {
      const call = normalize(params, callback);
      execute(sql, call.params).then(
        function (result) { if (call.callback) call.callback(null, result.rows); },
        function (error) { if (call.callback) call.callback(error, []); }
      );
      return db;
    },

    each(sql, params, rowCallback, doneCallback) {
      const call = normalize(params, rowCallback);
      const done = typeof params === 'function' ? rowCallback : doneCallback;
      execute(sql, call.params).then(
        function (result) {
          result.rows.forEach(function (row) { call.callback(null, row); });
          if (done) done(null, result.rows.length);
        },
        function (error) {
          if (done) done(error, 0);
          else call.callback(error);
        }
      );
      return db;
    },

    exec(sql, callback) {
      execute(sql, []).then(
        function () { if (callback) callback(null); },
        function (error) { if (callback) callback(error); }
      );
      return db;
    },

    // Statements queued inside the block already run in order (see `queue`
    // above), so this only has to invoke it. It stays because the schema and
    // the session store call it, and the ordering promise it makes is real.
    serialize(block) {
      if (block) block();
      return db;
    },

    parallelize(block) {
      if (block) block();
      return db;
    },

    close(callback) {
      enqueue(function () { return close ? close() : Promise.resolve(); }).then(
        function () { if (callback) callback(null); },
        function (error) { if (callback) callback(error); }
      );
    },

    // Resolves once every statement queued so far has finished. The schema
    // runs asynchronously at require() time, so the serverless entrypoint and
    // the tests await this instead of guessing with a timeout.
    ready() {
      return enqueue(function () { return Promise.resolve(); });
    }
  };

  return db;
}

module.exports = { createAdapter, toPositional, withReturning, shouldReturnId };
