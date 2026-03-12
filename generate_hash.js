// Скрипт для генерации bcrypt-хэша пароля
// Использование: node generate_hash.js <пароль>

const bcrypt = require('bcrypt');

const password = process.argv[2];

if (!password) {
    console.log('Использование: node generate_hash.js <пароль>');
    console.log('Пример: node generate_hash.js mySecretPassword');
    process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log('\nДобавьте в .env:');
console.log(`SITE_PASSWORD_HASH = ${hash}`);
