import Database from 'better-sqlite3';
const db = new Database('./store/messages.db');
const chats = db.prepare("SELECT * FROM registered_groups WHERE jid LIKE 'tg:%'").all();
console.log(JSON.stringify(chats, null, 2));
db.close();
