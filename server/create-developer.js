'use strict';

const readline = require('readline');
const db = require('./database');
const { hashPassword } = require('./auth-security');

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve =>
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    })
  );
}

function askHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    if (!input.isTTY || !output.isTTY) {
      reject(new Error('Run directly in the Termux terminal.'));
      return;
    }

    let answer = '';
    output.write(question);
    input.setRawMode(true);
    input.resume();

    function cleanup() {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
    }

    function onData(key) {
      const value = key.toString();

      if (value === '\u0003') {
        cleanup();
        output.write('\nCancelled.\n');
        process.exit(130);
      }

      if (value === '\r' || value === '\n') {
        cleanup();
        output.write('\n');
        resolve(answer);
        return;
      }

      if (value === '\u007f' || value === '\b') {
        answer = answer.slice(0, -1);
        return;
      }

      if (key.length === 1 && key[0] >= 32 && key[0] <= 126) {
        answer += value;
      }
    }

    input.on('data', onData);
  });
}

async function main() {
  const count = db.prepare(
    'SELECT COUNT(*) AS count FROM staff'
  ).get().count;

  if (count !== 0) {
    throw new Error(
      'Staff accounts already exist. Initial setup refused.'
    );
  }

  const username = (await ask('Developer username: ')).trim();

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new Error('Username must be 3–32 valid characters.');
  }

  const password = await askHidden('Password (12–128 characters): ');
  const confirmation = await askHidden('Confirm password: ');

  if (password !== confirmation) {
    throw new Error('Passwords do not match.');
  }

  const passwordHash = await hashPassword(password);

  const create = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO staff (username, password_hash, role, active)
      VALUES (?, ?, 'developer', 1)
    `).run(username, passwordHash);

    db.prepare(`
      INSERT INTO audit_log
        (actor_staff_id, action, target_type, target_id, details_json)
      VALUES (?, 'staff.created', 'staff', ?, ?)
    `).run(
      result.lastInsertRowid,
      String(result.lastInsertRowid),
      JSON.stringify({
        username,
        role: 'developer',
        method: 'initial_setup'
      })
    );

    return result.lastInsertRowid;
  });

  const id = create();

  console.log(`Developer account created. Staff ID: ${id}`);
  console.log('Password stored as a hash, not plain text.');
}

main().catch(error => {
  console.error('Setup failed:', error.message);
  process.exitCode = 1;
});
