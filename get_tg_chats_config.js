import Database from 'better-sqlite3';
const db = new Database('./store/messages.db');
const chats = db.prepare("SELECT container_config FROM registered_groups WHERE jid = 'tg:6325556041'").all();
console.log(chats[0].container_config);
db.close();
