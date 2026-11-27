require('dotenv').config();

const names = [
  'EVOLUTION_INSTANCE',
  'EVOLUTION_WEBHOOK_TOKEN',
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'DATABASE_URL'
];

for (const name of names) {
  const value = process.env[name];
  console.log(`${name}: ${value ? 'SET' : 'MISSING'}`);
}
