import Database from 'better-sqlite3';

const dbPath = './store/messages.db';
const db = new Database(dbPath);

const jid = 'trading_desk@internal';
const now = new Date().toISOString();

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
    const insertGroup = db.prepare(`
        INSERT OR REPLACE INTO registered_groups 
        (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertGroup.run(
        jid,
        "Trading Desk",
        "internal_trading-desk",
        "@Andy",
        now,
        JSON.stringify(containerConfig),
        1, // requires_trigger
        0  // is_main
    );

    console.log("Group 'Trading Desk' created with x-trade mounts.");
} catch (e) {
    console.error("Failed to insert into registered_groups", e);
}

db.close();
