// auth-tidb.js  ← reemplaza todo el contenido con esto

import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: Number(process.env.TIDB_PORT) || 4000,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE || 'bot_db',
  ssl: { rejectUnauthorized: false },
  connectionLimit: 5,
  waitForConnections: true,
  queueLimit: 0
});

// Logs de conexión inicial (para debug)
(async () => {
  try {
    const conn = await pool.getConnection();
    console.log('[TiDB AUTH] Conexión inicial OK');
    conn.release();
  } catch (err) {
    console.error('[TiDB AUTH] FALLO CONEXIÓN INICIAL:', err.message);
  }
})();

export async function useTiDBAuthState(sessionId = 'whatsapp_bot_principal') {
  const get = async (keyPath) => {
    try {
      const [rows] = await pool.execute(
        'SELECT value FROM baileys_keys WHERE session_id = ? AND key_path = ? LIMIT 1',
        [sessionId, keyPath]
      );
      if (rows.length === 0) return null;
      return rows[0].value;
    } catch (err) {
      console.error(`[TiDB GET] Error leyendo ${keyPath}:`, err.message);
      return null;
    }
  };

  const set = async (keyPath, value) => {
    if (value == null) {
      await pool.execute(
        'DELETE FROM baileys_keys WHERE session_id = ? AND key_path = ?',
        [sessionId, keyPath]
      );
      return;
    }
    const json = JSON.stringify(value);
    await pool.execute(
      `INSERT INTO baileys_keys (session_id, key_path, value)
       VALUES (?, ?, ?) 
       ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()`,
      [sessionId, keyPath, json, json]
    );
  };

  // ────────────────────────────────────────────────────────────────
  // CARGAR / INICIALIZAR CREDENTIALS (esto era lo que faltaba)
  // ────────────────────────────────────────────────────────────────
  let creds = await get('creds');

  // Si NO existen creds en DB → es primera vez → Baileys necesita un objeto vacío para empezar
  if (!creds) {
    console.log('[TiDB AUTH] No se encontraron creds → asumiendo primera conexión (QR vendrá)');
    creds = {};   // ← objeto vacío → Baileys lo completa y luego lo guarda vía saveCreds
  }

  const state = {
    creds,

    keys: {
      get: async (type, ids) => {
        const data = {};
        await Promise.all(
          ids.map(async (id) => {
            const val = await get(`${type}-${id}`);
            if (val) data[id] = val;
          })
        );
        return data;
      },

      set: async (data) => {
        const promises = [];
        for (const category in data) {
          for (const id in data[category]) {
            promises.push(set(`${category}-${id}`, data[category][id]));
          }
        }
        await Promise.all(promises);
      }
    }
  };

  const saveCreds = async () => {
    // Solo guardar si hay algo real (evitar guardar {} vacío)
    if (Object.keys(state.creds).length > 5) {  // rough check de que ya se poblaron
      await set('creds', state.creds);
      console.log('[TiDB AUTH] creds guardados en DB');
    }
  };

  return { state, saveCreds };
}