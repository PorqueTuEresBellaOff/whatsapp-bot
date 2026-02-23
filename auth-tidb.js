// auth-tidb.js
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: Number(process.env.TIDB_PORT) || 4000,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE || 'bot_db',
  ssl: { rejectUnauthorized: false },   // casi siempre necesario en TiDB Cloud
  connectionLimit: 5,                   // bajo para free tier
  waitForConnections: true,
  queueLimit: 0
});

// Opcional: prueba de conexión al iniciar (útil para debug)
(async () => {
  try {
    const conn = await pool.getConnection();
    console.log('→ Conexión exitosa a TiDB');
    conn.release();
  } catch (err) {
    console.error('× Error conectando a TiDB al inicio:', err.message);
  }
})();

export async function useTiDBAuthState(sessionId = 'whatsapp_bot_principal') {
  const getKey = async (keyPath) => {
    try {
      const [rows] = await pool.execute(
        'SELECT value FROM baileys_keys WHERE session_id = ? AND key_path = ?',
        [sessionId, keyPath]
      );
      if (rows.length === 0) return null;
      return rows[0].value; // ya es objeto porque lo guardamos como JSON
    } catch (err) {
      console.error(`Error leyendo key ${keyPath}:`, err.message);
      return null;
    }
  };

  const setKey = async (keyPath, value) => {
    if (value === undefined || value === null) {
      // Opcional: borrar si es null (limpieza)
      await pool.execute(
        'DELETE FROM baileys_keys WHERE session_id = ? AND key_path = ?',
        [sessionId, keyPath]
      );
      return;
    }

    const jsonValue = JSON.stringify(value);
    await pool.execute(
      `INSERT INTO baileys_keys (session_id, key_path, value)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()`,
      [sessionId, keyPath, jsonValue, jsonValue]
    );
  };

  // ── Credenciales principales ────────────────────────────────────────
  let creds = await getKey('creds');
  if (!creds) {
    creds = {}; // Baileys lo inicializará
  }

  const state = {
    creds,
    keys: {
      // ── Lectura de claves (get) ─────────────────────────────────────
      get: async (type, ids) => {
        const data = {};
        for (const id of ids) {
          const fullKey = `${type}-${id}`;
          const val = await getKey(fullKey);
          if (val) data[id] = val;
        }
        return data;
      },

      // ── Escritura de claves (set) ────────────────────────────────────
      set: async (data) => {
        for (const category in data) {
          for (const id in data[category]) {
            const fullKey = `${category}-${id}`;
            await setKey(fullKey, data[category][id]);
          }
        }
      }
    }
  };

  const saveCreds = async () => {
    if (Object.keys(state.creds).length > 0) {
      await setKey('creds', state.creds);
      console.log('[TiDB Auth] Creds guardadas');
    }
  };

  return { state, saveCreds };
}