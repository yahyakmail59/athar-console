import { pbkdf2Sync, randomBytes } from 'node:crypto';

const password = process.argv[2];
if (!password || password.length < 12) {
  console.error('الاستخدام: node scripts/generate-password-hash.mjs "كلمة-مرور-طويلة"');
  console.error('يجب ألا تقل كلمة المرور عن 12 حرفًا.');
  process.exitCode = 1;
} else {
  const salt = randomBytes(16);
  const derived = pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
  console.log(`${salt.toString('hex')}:${derived.toString('hex')}`);
}
