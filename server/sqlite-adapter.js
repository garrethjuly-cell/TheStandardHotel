'use strict';

// Compatibility layer for Node.js 22.13+ / 24+ built-in SQLite.
// Namecheap shared hosting may not support native npm addons such as better-sqlite3.
// This preserves the synchronous API used by this project without compiling a native addon.
const { DatabaseSync } = require('node:sqlite');

class SQLiteDatabase extends DatabaseSync {
  pragma(statement) {
    // This app uses PRAGMA assignments only during startup.
    this.exec(`PRAGMA ${statement}`);
  }

  transaction(callback) {
    if (typeof callback !== 'function') throw new TypeError('Transaction callback must be a function');
    const database = this;
    const execute = (mode) => function transactionRunner(...args) {
      database.exec(`BEGIN ${mode}`);
      try {
        const result = callback.apply(this, args);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch (_) { /* preserve original error */ }
        throw error;
      }
    };
    const immediate = execute('IMMEDIATE');
    immediate.immediate = immediate;
    immediate.deferred = execute('DEFERRED');
    immediate.exclusive = execute('EXCLUSIVE');
    return immediate;
  }
}

module.exports = SQLiteDatabase;
