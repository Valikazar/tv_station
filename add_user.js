// Скрипт для добавления нового пользователя
// Использование: node add_user.js <логин> <пароль>

const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

const login = process.argv[2];
const password = process.argv[3];

if (!login || !password) {
    console.log('Использование: node add_user.js <логин> <пароль>');
    console.log('Пример: node add_user.js newuser myPassword123');
    process.exit(1);
}

const usersPath = path.join(__dirname, 'users.json');

// Load existing users
let users = [];
try {
    const data = fs.readFileSync(usersPath, 'utf-8');
    users = JSON.parse(data);
} catch (err) {
    console.log('Файл users.json не найден, создаю новый...');
}

// Check if user already exists
if (users.find(u => u.login === login)) {
    console.error(`Ошибка: пользователь "${login}" уже существует!`);
    process.exit(1);
}

// Generate hash and add user
const passwordHash = bcrypt.hashSync(password, 10);
users.push({ login, passwordHash });

// Save
fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
console.log(`\nПользователь "${login}" успешно добавлен!`);
console.log(`Всего пользователей: ${users.length}`);
