import Database from 'better-sqlite3';

const db = new Database('./store/messages.db');

const jid = 'tg:6325556041';
const newFolder = 'internal_trading-desk';

const containerConfig = {
    additionalMounts: [
        {
            hostPath: "/home/ops/x-trade",
            containerPath: "xtrade",
            readonly: false
        }
    ]
};

try {
    const updateGroup = db.prepare(`
        UPDATE registered_groups 
        SET folder = ?, container_config = ?, name = ?
        WHERE jid = ? 
    `);
    
    // We are altering the existing Telegram chat to use the Trading Desk memory and mounts.
    const result = updateGroup.run(
        newFolder,
        JSON.stringify(containerConfig),
        "Telegram Trading Desk",
        jid
    );

    console.log(`Updated ${result.changes} row(s). Telegram chat is now mapped to ${newFolder}`);
} catch (e) {
    console.error("Failed to update telegram chat", e);
}

db.close();
