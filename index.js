// ===============================
// BOT WHATSAPP – PORQUE TÚ ERES BELLA
// Baileys ACTUAL (SOLO RESPUESTAS DE TEXTO)
// Firebase + Google Calendar
// Citas como ARRAY dentro del cliente
// ===============================
import express from "express";
import { Mutex } from 'async-mutex';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import pino from "pino"; // Logger

import { crearEvento, eliminarEvento} from "./googleCalendar.js";
import { obtenerHorasDisponibles, estaHoraDisponibleAhora } from "./disponibilidad.js";

// ===============================
// CONFIGURACIÓN DEL GRUPO PARA NOTIFICACIONES Y MODO ADMIN
// ===============================
const GROUP_ID = '120363424425387340@g.us'; // ← CAMBIAR AQUÍ: Reemplaza con el ID real de tu grupo

// NOTA: Ahora CUALQUIER mensaje enviado a este grupo se considera comando ADMIN
// No se necesita lista de números administradores

// ===============================
// FIREBASE
// ===============================
import admin from "firebase-admin";

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://porquetueresbellaoficial-default-rtdb.firebaseio.com"  // ← CAMBIAR
  });
}

const db = admin.database();

// ===============================
// DATOS BASE
// ===============================
const serviciosLista = [
  { id: '1', key: 'BALAYAGE_RUBIO', nombre: "Balayage rubio", duracion: 8 },
  { id: '2', key: 'BALAYAGE_SIN', nombre: "Balayage sin decoloración", duracion: 4 },
  { id: '3', key: 'CORTE', nombre: "Corte y peinado", duracion: 1.25 },
  { id: '4', key: 'TRATAMIENTO_INT', nombre: "Tratamiento intensivo", duracion: 2 },
  { id: '5', key: 'TRATAMIENTO_DISC', nombre: "Tratamiento disciplinante", duracion: 4 },
  { id: '6', key: 'DIAGNOSTICO', nombre: "Diagnóstico", duracion: 0.75 }
];

const servicios = serviciosLista.reduce((acc, s) => {
  acc[s.key] = { nombre: s.nombre, duracion: s.duracion };
  return acc;
}, {});

const serviciosPorNombre = serviciosLista.reduce((acc, s) => {
  acc[s.nombre.toUpperCase()] = s;
  return acc;
}, {});

const empleadosLista = [
  { id: '1', key: 'CARLOS', nombre: "Carlos" },
  { id: '2', key: 'ARTURO', nombre: "Arturo" }
];

const empleados = empleadosLista.reduce((acc, e) => {
  acc[e.key] = { nombre: e.nombre };
  return acc;
}, {});

// ===============================
// MEMORIA
// ===============================
const conversaciones = new Map();
const adminState = {}; // solo tendrá clave = GROUP_ID
const recordatoriosActivos = {};

// Al inicio del archivo, junto con los otros Maps
const conversationMutexes = new Map();  // mapa: número → candado

function getConversationMutex(from) {
  if (!conversationMutexes.has(from)) {
    conversationMutexes.set(from, new Mutex());  // nuevo candado solo para este usuario
  }
  return conversationMutexes.get(from);
}

function getConversacion(from) {
  if (!conversaciones.has(from)) {
    conversaciones.set(from, {
      estado: "INICIO",
      temp: {},
      lastActivity: Date.now()
    });
  }
  const conv = conversaciones.get(from);
  conv.lastActivity = Date.now(); // actualizamos actividad
  return conv;
}

// ===============================
// UTILIDADES
// ===============================
function formatearDuracion(horas) {
  const h = Math.floor(horas);
  const m = Math.round((horas - h) * 60);
  let t = "";
  if (h > 0) t += `${h} hora${h > 1 ? "s" : ""}`;
  if (m > 0) t += ` ${m} minuto${m > 1 ? "s" : ""}`;
  return t || "0 minutos";
}

function formatearFecha(fecha) {
  return fecha.toLocaleDateString("es-CO", {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function programarRecordatorio(sock, numeroCompletoCliente, cita, clienteData) {
  if (!cita || !cita.inicio || !cita.eventId) {
    console.warn("Intento de programar recordatorio con cita inválida:", cita);
    return null;
  }
 
  const key = cita.eventId;
 
  const fechaCita = new Date(cita.inicio);
  const ahora = new Date();
  if (fechaCita <= ahora) return null;
  if (cita.recordatorioEnviado === true) return null;

  // Rechazar si la cita está a más de 20 días en el futuro
  const maxDelayDias = 20;
  const maxDelayMs = maxDelayDias * 24 * 60 * 60 * 1000;
  if (fechaCita.getTime() - ahora.getTime() > maxDelayMs) {
    console.log(`Recordatorio rechazado para cita en más de ${maxDelayDias} días: ${key}`);
    return null;
  }

  // ── 2 horas antes ────────────────────────────────
  const dosHorasAntes = new Date(fechaCita.getTime() - 2 * 60 * 60 * 1000);
  const faltanMenosDe2Horas = ahora >= dosHorasAntes;
  const delay = faltanMenosDe2Horas
    ? 30000 // ~30 segundos si ya está muy cerca
    : dosHorasAntes.getTime() - ahora.getTime();
  if (delay <= 0) return null;
  const timeoutId = setTimeout(async () => {
    try {
      const fechaHoraCita = fechaCita.toLocaleString("es-CO", {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
      // 1. Mensaje al CLIENTE
      let mensajeCliente = "";
      if (faltanMenosDe2Horas) {
        mensajeCliente = `🚨 ¡ATENCIÓN! Tu cita es **HOY** en menos de 2 horas!\n\n` +
                        `💇‍♀️ *${cita.servicio}* con ${cita.empleado}\n` +
                        `🕐 ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit', hour12: true })}\n\n` +
                        `¡Por favor ven con tiempo! Te esperamos con cariño 💖 \n\n` +
                        'Si deseas cancelarla puedes entrar a la seccion "Consultar cita" ezcribiendo "MENU" y luego "2" \n\n' +
                        'Recuerda que estamos ubicados en la Carrera 19 # 70A - 31 edificio alexandra 301, Barrios Unidos, Chapinero centrar, Bogotá D.C.';
      } else {
        mensajeCliente = `⏰ *Recordatorio de cita* (2 horas antes)\n\n` +
                        `💇‍♀️ *${cita.servicio}* con ${cita.empleado}\n` +
                        `📅 ${formatearFecha(fechaCita)}\n` +
                        `🕐 ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit', hour12: true })}\n\n` +
                        `¡Te esperamos! 💖 \n\n` +
                        'Si deseas cancelarla puedes entrar a la seccion "Consultar cita" ezcribiendo "MENU" y luego "2" \n\n' + 
                        'Recuerda que estamos ubicados en la Carrera 19 # 70A - 31 edificio alexandra 301, Barrios Unidos, Chapinero centrar, Bogotá D.C.';
      }
      await sock.sendMessage(numeroCompletoCliente, { text: mensajeCliente });
      // 2. Mensaje al GRUPO DE ADMINS
      const mensajeGrupo = `🔔 *RECORDATORIO 2 HORAS* - Cita próxima\n\n` +
                          `👤 ${clienteData.nombre || 'Cliente'} (${clienteData.cedula})\n` +
                          `📱 ${clienteData.celular ? '57' + clienteData.celular : 'No registrado'}\n` +
                          `💇‍♀️ ${cita.servicio}\n` +
                          `👨‍💼 ${cita.empleado}\n` +
                          `📅 ${formatearFecha(fechaCita)}\n` +
                          `🕐 ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit', hour12: true })}\n\n` +
                          `¡Preparar estación y recibir al cliente! ✨`;
      await sock.sendMessage(GROUP_ID, { text: mensajeGrupo });
      // Marcar como enviado (importante para no repetir)
      const clienteRef = db.ref(`clientes/${clienteData.cedula}`);
      await clienteRef.transaction(current => {
        if (!current?.citas) return current;
        const idx = current.citas.findIndex(c => c.inicio === cita.inicio);
        if (idx === -1) return current;
        current.citas[idx].recordatorioEnviado = true;
        return current;
      });
      console.log(`Recordatorios enviados (cliente + grupo) → ${clienteData.cedula} - ${cita.servicio}`);
      delete recordatoriosActivos[key];
    } catch (err) {
      console.error("Error enviando recordatorios (cliente/grupo):", err);
      delete recordatoriosActivos[key];
    }
  }, delay);
 
  recordatoriosActivos[key] = timeoutId;
  return timeoutId;
}

function programarLimpiezaDiaria() {
  const ahora = new Date();
  const medianoche = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + 1, 0, 0, 0);
  const delay = medianoche.getTime() - ahora.getTime();

  setTimeout(() => {
    limpiarCitasPasadas();
    programarLimpiezaDiaria(); // Recursivo para el próximo día
  }, delay);
}

async function limpiarCitasPasadas() {
  console.log("🧹 Iniciando limpieza de citas pasadas...");

  try {
    const clientesSnap = await db.ref('clientes').once('value');
    if (!clientesSnap.exists()) return;

    let eliminadas = 0;

    const clientesData = clientesSnap.val() || {};

    for (const [cedula, cliente] of Object.entries(clientesData)) {
      if (!cliente?.citas || !Array.isArray(cliente.citas)) {
        console.warn(`Cliente ${cedula} no tiene citas válidas (no es array)`);
        continue;
      }

      const citasActualizadas = [];
      let huboCambios = false;

      for (const cita of cliente.citas) {
        if (!cita || typeof cita !== 'object' || !cita.inicio) {
          console.warn(`Cita inválida encontrada y omitida para cliente ${cedula}:`, cita);
          huboCambios = true;
          continue;
        }

        if (new Date(cita.inicio) > new Date()) {
          citasActualizadas.push(cita);
          continue;
        }

        if (cita.eventId) {
          try {
            await eliminarEvento(cita.eventId, cita.empleado);
            console.log(`Evento GC eliminado → ${cita.eventId}`);
            if (recordatoriosActivos[cita.eventId]) {
              clearTimeout(recordatoriosActivos[cita.eventId]);
              delete recordatoriosActivos[cita.eventId];
            }
          } catch (err) {
            console.warn(`No se pudo eliminar evento GC ${cita.eventId}:`, err.message);
          }
        }

        eliminadas++;
        huboCambios = true;
      }

      if (huboCambios) {
        await db.ref(`clientes/${cedula}`).update({
          citas: citasActualizadas
        });
        console.log(`Cliente ${cedula} actualizado - ${citasActualizadas.length} citas restantes`);
      }
    }

    console.log(`Limpieza finalizada. Eliminadas ${eliminadas} citas pasadas.`);
  } catch (err) {
    console.error("Error limpiando citas pasadas:", err);
  }
}

async function obtenerCitasExistentes(cedula) {
  const clienteRef = db.ref(`clientes/${cedula}`);
  const snapshot = await clienteRef.once('value');
  
  if (!snapshot.exists()) {
    return [];
  }

  const data = snapshot.val();
  const citasArray = data.citas || [];

  const futuras = citasArray
    .map((cita, index) => ({
      ...cita,
      arrayIndex: index
    }))
    .filter(cita => new Date(cita.inicio) > new Date())
    .sort((a, b) => new Date(a.inicio) - new Date(b.inicio));

  return futuras;
}

async function tieneDiagnosticoPendiente(cedula) {
  const clienteRef = db.ref(`clientes/${cedula}`);
  const snapshot = await clienteRef.once('value');
  
  if (!snapshot.exists()) {
    return false;
  }

  const data = snapshot.val();
  const citas = data.citas || [];

  return citas.some(cita => 
    new Date(cita.inicio) > new Date() && 
    cita.servicio === "Diagnóstico"
  );
}

async function requiereDiagnostico(cedula) {
  const clienteRef = db.ref(`clientes/${cedula}`);
  const snapshot = await clienteRef.once('value');
  
  if (!snapshot.exists()) {
    return true;
  }

  const data = snapshot.val();
  return data.requiereDiagnostico === true;
}

async function reprogramarRecordatoriosPendientes(sock) {
  console.log("🔄 Reprogramando recordatorios pendientes...");
  try {
    const clientesSnap = await db.ref('clientes').once('value');
    if (!clientesSnap.exists()) return;
    let programados = 0;
    clientesSnap.forEach((clienteSnap) => {
      const cliente = clienteSnap.val();
      const cedula = clienteSnap.key;
      const citas = cliente.citas || [];
      citas.forEach(cita => {
        if (cita.estado !== "confirmada") return;
        if (new Date(cita.inicio) <= new Date()) return;
        if (cita.recordatorioEnviado === true) return;
        if (!cliente.celular) return;
        if (!cita.eventId) return;
        const numeroCompleto = `57${cliente.celular}@s.whatsapp.net`;
        programarRecordatorio(sock, numeroCompleto, cita, { ...cliente, cedula });
        programados++;
      });
    });
    console.log(`Se programaron ${programados} recordatorios pendientes.`);
  } catch (err) {
    console.error("Error reprogramando recordatorios:", err);
  } finally {
    // Llamada recursiva cada 24 horas
    setTimeout(() => reprogramarRecordatoriosPendientes(sock), 24 * 60 * 60 * 1000);
  }
}

// Nueva función: Obtener TODAS las citas futuras (para admins)
async function obtenerTodasCitasFuturas() {
  try {
    const snapshot = await db.ref('clientes').once('value');
    if (!snapshot.exists()) return [];

    const todasCitas = [];

    snapshot.forEach((clienteSnap) => {
      const cliente = clienteSnap.val();
      const cedula = clienteSnap.key;

      if (cliente.citas && Array.isArray(cliente.citas)) {
        cliente.citas.forEach(cita => {
          if (new Date(cita.inicio) > new Date() && cita.estado === "confirmada") {
            todasCitas.push({
              cedula,
              nombre: cliente.nombre || "Sin nombre",
              celular: cliente.celular || null,
              ...cita
            });
          }
        });
      }
    });

    return todasCitas.sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
  } catch (err) {
    console.error("Error obteniendo todas las citas futuras:", err);
    return [];
  }
}

// ===============================
// BOT
// ===============================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, qr }) => {
    if (qr) {
      console.log("🔗 Escanea este QR con tu WhatsApp:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("✅ Bot conectado exitosamente");
      limpiarCitasPasadas();
      reprogramarRecordatoriosPendientes(sock);
      programarLimpiezaDiaria();
      setInterval(() => {
        const ahora = Date.now();
        for (const [from, conv] of conversaciones) {
          if (ahora - conv.lastActivity > 30 * 60 * 1000) { // 30 minutos sin actividad
            console.log(`🧹 Limpiando conversación inactiva: ${from}`);
            conversaciones.delete(from);
          }
        }
      }, 5 * 60 * 1000); // revisar cada 5 minutos
    } else if (connection === "close") {
      console.log("❌ Bot desconectado, reconectando...");
      setTimeout(startBot, 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;

    const release = await getConversationMutex(from).acquire();

    try{
      console.log("ID del remitente:", from);
      const conv = getConversacion(from);

      const originalText = msg.message.conversation?.trim() || 
                          msg.message.extendedTextMessage?.text?.trim() || '';

      const respuesta = originalText.toUpperCase().trim();

      if (!respuesta) return;

      console.log(`📱 Mensaje desde ${from}: ${originalText}`);

      const esGrupoAdmin = from === GROUP_ID;

      // Posibles valores de adminState[GROUP_ID]
      const ADMIN_MODES = {
        MAIN:          'main',
        LIST_CITAS:    'list_citas',
        CANCEL_SELECT: 'cancel_select',
        CANCEL_CONFIRM:'cancel_confirm',
        BLOCK_WHO:     'block_who',
        BLOCK_DATE:    'block_date',
        BLOCK_TYPE:    'block_type',     // todo el día o rango
        BLOCK_RANGE:   'block_range',    // pidiendo las dos horas
        BLOCK_CONFIRM: 'block_confirm',
        AGENDAR_START:      'agendar_start',
        AGENDAR_CEDULA:     'agendar_cedula',
        AGENDAR_SERVICIO:   'agendar_servicio',
        AGENDAR_EMPLEADO:   'agendar_empleado',
        AGENDAR_NOMBRE:     'agendar_nombre',
        AGENDAR_CELULAR:    'agendar_celular',
        AGENDAR_CONFIRMAR:  'agendar_confirmar',
        AGENDAR_MES:        'agendar_mes',
        AGENDAR_SEMANA:     'agendar_semana',
        AGENDAR_DIA:        'agendar_dia',
        AGENDAR_HORA:       'agendar_hora'
      };
      // ===============================
      // COMANDOS ADMIN (solo en el grupo)
      // Cualquier mensaje en el grupo se considera comando admin
      // ===============================
      // ────────────────────────────────────────────────
      //          NUEVO MANEJO DE ADMIN – MENÚ INTERACTIVO
      // ────────────────────────────────────────────────

      // ===============================
      // COMANDOS ADMIN (solo en el grupo)
      // Cualquier mensaje en el grupo se considera comando admin
      // ===============================
      if (esGrupoAdmin) {
        const groupId = from;

        if (!adminState[groupId]) {
          adminState[groupId] = { mode: 'main', data: {} };
        }

        let text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const textUpper = text.toUpperCase();

        console.log(`[ADMIN] Modo: ${adminState[groupId].mode} | Texto recibido: "${text}" (${textUpper})`);

        const sendAdmin = async (txt) => {
          await sock.sendMessage(groupId, { text: txt });
        };

        // ── Comandos de escape / volver (prioridad máxima) ────────────────────────────────
        if (["MENU", "INICIO", "VOLVER", "ATRAS", "0"].includes(textUpper)) {
          adminState[groupId].mode = 'main';
          adminState[groupId].data = {};
          
          const menuText = 
                `🛠️ *MENÚ ADMINISTRACIÓN – Porque Tú Eres Bella*\n\n` +
                `¿Qué deseas hacer?\n\n` +
                `1️⃣ Ver todas las citas futuras\n` +
                `2️⃣ Cancelar una cita\n` +
                `3️⃣ Bloquear agenda de estilista(s)\n` +
                `4️⃣ Agendar cita para una clienta\n` +   // ← NUEVA LÍNEA
                `5️⃣ Ayuda rápida\n\n` +                   // ← Cambia 4 → 5
                `Escribe solo el número (1-5)\n` +         // ← Cambia 1-4 → 1-5
                `• Escribe MENU en cualquier momento para volver aquí`;

          await sendAdmin(menuText);
          return;
        }

        const currentMode = adminState[groupId].mode;

        // ── MODO PRINCIPAL ───────────────────────────────────────────────────────────────
        if (currentMode === 'main') {
          if (textUpper === '1') {
            adminState[groupId].mode = 'list_citas';

            const todas = await obtenerTodasCitasFuturas();

            if (todas.length === 0) {
              await sendAdmin("📅 No hay citas futuras registradas en este momento.\n\nEscribe MENU para volver.");
              adminState[groupId].mode = 'main';
              return;
            }

            let txt = "📅 *CITAS CONFIRMADAS FUTURAS* (ordenadas por fecha)\n\n";
            todas.forEach((c, i) => {
              const fecha = new Date(c.inicio);
              txt += `${i+1}. ${c.nombre} (${c.cedula})\n`;
              txt += `   • ${c.servicio}\n`;
              txt += `   • ${c.empleado}\n`;
              txt += `   • ${formatearFecha(fecha)} ${fecha.toLocaleTimeString("es-CO", {hour:'2-digit', minute:'2-digit'})}\n\n`;
            });

            txt += "Escribe MENU para volver al menú principal.";
            await sendAdmin(txt);
            return;
          }

          if (textUpper === '2') {
            adminState[groupId].mode = 'cancel_select';

            const todas = await obtenerTodasCitasFuturas();

            if (todas.length === 0) {
              await sendAdmin("No hay citas para cancelar en este momento.\n\nEscribe MENU para volver.");
              adminState[groupId].mode = 'main';
              return;
            }

            let txt = "❌ *SELECCIONA LA CITA A CANCELAR*\n\n";
            todas.forEach((c, i) => {
              const fecha = new Date(c.inicio);
              txt += `${i+1}) ${c.nombre} (${c.cedula}) – ${c.servicio} con ${c.empleado}\n`;
              txt += `    ${formatearFecha(fecha)} ${fecha.toLocaleTimeString("es-CO", {hour:'2-digit', minute:'2-digit'})}\n\n`;
            });

            txt += "Escribe el **número** de la cita que deseas cancelar\n";
            txt += "o escribe MENU para volver";

            await sendAdmin(txt);
            return;
          }

          if (textUpper === '3') {
            adminState[groupId].mode = 'block_who';
            await sendAdmin(
              `🛑 *BLOQUEAR AGENDA*\n\n` +
              `¿A quién(es) deseas bloquear?\n\n` +
              `1️⃣ Carlos\n` +
              `2️⃣ Arturo\n` +
              `3️⃣ Ambos\n\n` +
              `Escribe el número (1,2,3) o MENU para volver`
            );
            return;
          }

          if (textUpper === '4') {
            adminState[groupId].mode = ADMIN_MODES.AGENDAR_START;
            adminState[groupId].data = {
              cedula: null,
              nombre: null,
              celular: null,
              servicio: null,
              empleado: null,
              temp: {},           // simula el temp del flujo cliente
              mesesDisponibles: null,
              semanasDelMes: null,
              dias: null,
              horas: null,
              esNuevoCliente: null,
              requiereDiagnostico: null
            };

            await sendAdmin(
              `📅 *Modo agendamiento completo para clienta*\n\n` +
              `Vamos a seguir **exactamente** el mismo proceso que una clienta.\n\n` +
              `Paso 1 → Escribe la **cédula** de la clienta (solo números, ej: 123456789)\n\n` +
              `Escribe MENU para salir en cualquier momento.`
            );
            return;
          }

          if (textUpper === '5') {
            await sendAdmin(
              `🆘 *AYUDA RÁPIDA ADMIN*\n\n` +
              `• Usa los números del menú principal\n` +
              `• En cualquier momento escribe MENU para volver\n` +
              `• Los bloqueos se guardan en clientes/-1\n` +
              `• Las cancelaciones notifican al cliente automáticamente\n\n` +
              `¡Cualquier duda pregunta! 💜`
            );
            return;
          }

          // Respuesta inválida en modo main
          await sendAdmin("Por favor escribe solo el número de la opción (1,2,3,4)\nO MENU para refrescar el menú.");
          return;
        }

        // ────────────────────────────────────────────────
        //     FLUJO COMPLETO DE AGENDAMIENTO DESDE ADMIN
        // ────────────────────────────────────────────────
        if (currentMode.startsWith('agendar_') || currentMode === ADMIN_MODES.AGENDAR_START) {
          const data = adminState[groupId].data;
          const upper = text.toUpperCase().trim();

          // ── ESCAPE ───────────────────────────────────────
          if (["MENU", "INICIO", "VOLVER", "ATRAS", "0"].includes(upper)) {
            adminState[groupId].mode = 'main';
            adminState[groupId].data = {};
            await sendAdmin("Modo agendamiento cancelado. Volviste al menú principal.");
            return;
          }

          // ── AGENDAR_START → pedir cédula ─────────────────
          if (currentMode === ADMIN_MODES.AGENDAR_START) {
            if (!/^\d{5,}$/.test(text)) {
              await sendAdmin("❗ Cédula inválida. Solo números (mínimo 5 dígitos).\nIntenta de nuevo.");
              return;
            }
            data.cedula = text.trim();
            adminState[groupId].mode = ADMIN_MODES.AGENDAR_SERVICIO;

            const listaServicios = serviciosLista.map(s => 
              `${s.id}️⃣ ${s.nombre} - ${formatearDuracion(s.duracion)}`
            ).join('\n');

            await sendAdmin(
              `Cédula: ${data.cedula}\n\n` +
              `Paso 2 → Selecciona el servicio:\n\n${listaServicios}\n\n` +
              `Escribe el número (1-6)`
            );
            return;
          }

          // ── AGENDAR_SERVICIO ─────────────────────────────
          if (currentMode === ADMIN_MODES.AGENDAR_SERVICIO) {
            const sel = serviciosLista.find(s => s.id === text.trim());
            if (!sel) {
              await sendAdmin("Número de servicio inválido (1-6). Intenta de nuevo.");
              return;
            }
            data.servicio = { nombre: sel.nombre, duracion: sel.duracion };
            adminState[groupId].mode = ADMIN_MODES.AGENDAR_EMPLEADO;

            const listaEmpleados = empleadosLista.map(e => 
              `${e.id}️⃣ ${e.nombre}`
            ).join('\n');

            await sendAdmin(
              `Servicio: ${data.servicio.nombre}\n\n` +
              `Paso 3 → Elige estilista:\n\n${listaEmpleados}\n\n` +
              `Escribe 1 o 2`
            );
            return;
          }

          // ── AGENDAR_EMPLEADO ─────────────────────────────
          if (currentMode === ADMIN_MODES.AGENDAR_EMPLEADO) {
            const sel = empleadosLista.find(e => e.id === text.trim());
            if (!sel) {
              await sendAdmin("Elige 1 (Carlos) o 2 (Arturo).");
              return;
            }
            data.empleado = { nombre: sel.nombre };
            adminState[groupId].mode = ADMIN_MODES.AGENDAR_CEDULA;  // ya tenemos cédula, pero verificamos cliente

            // Verificamos si existe el cliente (igual que en flujo normal)
            const clienteRef = db.ref(`clientes/${data.cedula}`);
            const snap = await clienteRef.once('value');

            if (snap.exists()) {
              const cliente = snap.val();
              data.nombre = cliente.nombre || "Cliente";
              data.celular = cliente.celular || null;
              data.temp.nombre = data.nombre;
              data.temp.celular = data.celular;
              data.temp.cedula = data.cedula;

              // Chequeo diagnóstico pendiente
              const hasPending = await tieneDiagnosticoPendiente(data.cedula);
              if (hasPending && data.servicio.nombre !== "Diagnóstico") {
                await sendAdmin(
                  `⚠️ La clienta tiene diagnóstico pendiente.\n` +
                  `Ajustamos el servicio a Diagnóstico.`
                );
                const diag = serviciosLista.find(s => s.id === '6');
                data.servicio = { nombre: diag.nombre, duracion: diag.duracion };
              }

              adminState[groupId].mode = ADMIN_MODES.AGENDAR_CONFIRMAR;
              await sendAdmin(
                `Cliente encontrado:\n` +
                `Nombre: ${data.nombre}\n` +
                `Celular: ${data.celular || "sin registrar"}\n\n` +
                `Servicio: ${data.servicio.nombre}\n` +
                `Estilista: ${data.empleado.nombre}\n\n` +
                `¿Continuamos? Escribe SI o NO para actualizar datos`
              );
            } else {
              adminState[groupId].mode = ADMIN_MODES.AGENDAR_NOMBRE;
              await sendAdmin(
                `No existe registro con cédula ${data.cedula}.\n` +
                `Paso 4 → Escribe el NOMBRE COMPLETO de la clienta:`
              );
            }
            return;
          }

          // ── AGENDAR_NOMBRE (nueva clienta) ───────────────
          if (currentMode === ADMIN_MODES.AGENDAR_NOMBRE) {
            if (text.trim().length < 2) {
              await sendAdmin("Nombre muy corto. Escribe nombre completo.");
              return;
            }
            data.nombre = text.trim();
            data.temp.nombre = data.nombre;
            adminState[groupId].mode = ADMIN_MODES.AGENDAR_CELULAR;
            await sendAdmin(
              `Nombre: ${data.nombre}\n\n` +
              `Paso 5 → Escribe el número de celular (10 dígitos, ej: 3001234567):`
            );
            return;
          }

          // ── AGENDAR_CELULAR ──────────────────────────────
          if (currentMode === ADMIN_MODES.AGENDAR_CELULAR) {
            if (!/^\d{10}$/.test(text.trim())) {
              await sendAdmin("Celular inválido. 10 dígitos sin espacios ni signos.");
              return;
            }
            data.celular = text.trim();
            data.temp.celular = data.celular;

            // Guardamos cliente nuevo (igual que flujo normal)
            const clienteRef = db.ref(`clientes/${data.cedula}`);
            await clienteRef.set({
              nombre: data.nombre,
              celular: data.celular,
              citas: [],
              requiereDiagnostico: data.servicio.nombre === "Diagnóstico"
            });

            adminState[groupId].mode = ADMIN_MODES.AGENDAR_CONFIRMAR;
            await sendAdmin(
              `Datos registrados:\n\n` +
              `Cédula:   ${data.cedula}\n` +
              `Nombre:   ${data.nombre}\n` +
              `Celular:  ${data.celular}\n` +
              `Servicio: ${data.servicio.nombre}\n` +
              `Estilista:${data.empleado.nombre}\n\n` +
              `Escribe SI para continuar a elegir fecha/hora`
            );
            return;
          }

          // ── AGENDAR_CONFIRMAR (cliente existente o nuevo) ─
          if (currentMode === ADMIN_MODES.AGENDAR_CONFIRMAR) {
            if (["SI", "SÍ"].includes(upper)) {
              // Iniciamos selección de mes (igual que cliente)
              const meses = obtenerMesesProximos(4);
              data.mesesDisponibles = meses;

              let texto = `📅 *Selecciona el mes*\n\n`;
              meses.forEach(m => {
                texto += `${m.indice + 1}️⃣ ${m.nombre.charAt(0).toUpperCase() + m.nombre.slice(1)}\n`;
              });
              texto += "\nEscribe el número del mes";

              await sendAdmin(texto);
              adminState[groupId].mode = ADMIN_MODES.AGENDAR_MES;
              return;
            } else if (["NO"].includes(upper)) {
              adminState[groupId].mode = ADMIN_MODES.AGENDAR_NOMBRE;
              await sendAdmin("Ok, volvamos a ingresar nombre y celular.\nEscribe el nombre completo:");
              return;
            }
            await sendAdmin("Escribe SI o NO.");
            return;
          }

          // ── AGENDAR_MES ──────────────────────────────────
          if (currentMode === ADMIN_MODES.AGENDAR_MES) {
            const idx = parseInt(text) - 1;
            if (isNaN(idx) || idx < 0 || idx >= data.mesesDisponibles.length) {
              await sendAdmin("Mes inválido. Elige 1 al 4.");
              return;
            }
            const mesElegido = data.mesesDisponibles[idx];
            data.mesSeleccionado = mesElegido;

            // Aquí copiamos la lógica de semanas (es larga, pero igual que cliente)
            const ahora = new Date();
            const hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 0, 0, 0);
            const primerDiaMes = new Date(mesElegido.year, mesElegido.mes, 1);
            const ultimoDiaMes = new Date(mesElegido.year, mesElegido.mes + 1, 0);

            let primerLunes = new Date(primerDiaMes);
            while (primerLunes.getDay() !== 0 && primerLunes <= ultimoDiaMes) {
              primerLunes.setDate(primerLunes.getDate() + 1);
            }

            const semanas = [];
            let diaActual = new Date(primerLunes);
            while (diaActual <= ultimoDiaMes) {
              const inicioSemana = new Date(diaActual);
              const finSemana = new Date(diaActual);
              finSemana.setDate(finSemana.getDate() + 6);

              const manana = new Date(hoy);
              manana.setDate(manana.getDate() + 1);

              if (finSemana >= manana) {
                semanas.push({
                  indice: semanas.length,
                  inicio: inicioSemana,
                  fin: finSemana,
                  label: `Semana del ${inicioSemana.getDate()} al ${finSemana.getDate()} de ${inicioSemana.toLocaleDateString('es-CO', { month: 'long' })}`
                });
              }
              diaActual.setDate(diaActual.getDate() + 7);
            }

            if (semanas.length === 0) {
              await sendAdmin("No hay semanas disponibles en ese mes.\nElige otro mes.");
              return;
            }

            data.semanasDelMes = semanas;

            let texto = `📆 *Semanas en ${mesElegido.nombre}*\n\n`;
            semanas.forEach(s => {
              texto += `${s.indice + 1}️⃣ ${s.label}\n`;
            });
            texto += "\nEscribe el número de la semana";

            await sendAdmin(texto);
            adminState[groupId].mode = ADMIN_MODES.AGENDAR_SEMANA;
            return;
          }

          // ── AGENDAR_SEMANA ───────────────────────────────
          if (currentMode === ADMIN_MODES.AGENDAR_SEMANA) {
            const idx = parseInt(text) - 1;
            if (isNaN(idx) || idx < 0 || idx >= data.semanasDelMes.length) {
              await sendAdmin("Semana inválida.");
              return;
            }
            const semana = data.semanasDelMes[idx];
            data.semanaSeleccionada = semana;

            const disponibles = await obtenerHorasDisponibles({
              startDate: semana.inicio,
              dias: 7,
              duracionHoras: data.servicio.duracion,
              empleado: data.empleado.nombre
            });

            const diasEnSemana = disponibles.filter(dia => {
              const f = new Date(dia.fechaISO);
              return f >= semana.inicio && f <= semana.fin;
            });

            if (diasEnSemana.length === 0) {
              await sendAdmin("No hay días disponibles en esa semana.\nElige otra.");
              return;
            }

            data.dias = diasEnSemana;

            let texto = `📅 *Días disponibles*\n\n`;
            diasEnSemana.forEach((d, i) => {
              texto += `${i + 1}️⃣ ${d.fecha} (${d.slots.length} horarios)\n`;
            });
            texto += "\nEscribe el número del día";

            await sendAdmin(texto);
            adminState[groupId].mode = ADMIN_MODES.AGENDAR_DIA;
            return;
          }

          // ── AGENDAR_DIA ──────────────────────────────────
          if (currentMode === ADMIN_MODES.AGENDAR_DIA) {
            const idx = parseInt(text) - 1;
            if (isNaN(idx) || idx < 0 || idx >= data.dias.length) {
              await sendAdmin("Día inválido.");
              return;
            }
            const dia = data.dias[idx];
            data.horas = dia.slots;
            data.diaSeleccionado = dia;

            const opciones = dia.slots.map((h, i) => `${i + 1}️⃣ ${h.label}`).join('\n');

            await sendAdmin(
              `🕐 *Horarios para ${dia.fecha}*\n\n` +
              `${opciones}\n\nEscribe el número del horario`
            );
            adminState[groupId].mode = ADMIN_MODES.AGENDAR_HORA;
            return;
          }

          // ── AGENDAR_HORA → CREAR CITA ────────────────────
          if (currentMode === ADMIN_MODES.AGENDAR_HORA) {
            const idx = parseInt(text) - 1;
            if (isNaN(idx) || idx < 0 || idx >= data.horas.length) {
              await sendAdmin("Horario inválido.");
              return;
            }

            const horaSel = data.horas[idx];

            // Verificación final de disponibilidad
            const disponible = await estaHoraDisponibleAhora({
              empleado: data.empleado.nombre,
              inicioISO: horaSel.inicioISO,
              duracionHoras: data.servicio.duracion
            });

            if (!disponible) {
              await sendAdmin(
                `⛔ La hora ${horaSel.label} ya no está disponible.\n` +
                `Vuelve a elegir día u horario.`
              );
              adminState[groupId].mode = ADMIN_MODES.AGENDAR_DIA;
              return;
            }

            // ── Crear cita (igual que flujo cliente) ───────
            try {
              const eventId = await crearEvento({
                nombre: `${data.nombre} (${data.cedula})`,
                servicio: data.servicio.nombre,
                empleado: data.empleado.nombre,
                inicioISO: horaSel.inicioISO,
                duracionHoras: data.servicio.duracion,
                telefono: data.celular,
                cedula: data.cedula,
                esCambio: false
              });

              const citaData = {
                nombre: data.nombre,
                cedula: data.cedula,
                servicio: data.servicio.nombre,
                empleado: data.empleado.nombre,
                inicio: horaSel.inicioISO,
                fechaCreacion: new Date().toISOString(),
                estado: "confirmada",
                eventId,
                recordatorioEnviado: false
              };

              const clienteRef = db.ref(`clientes/${data.cedula}`);
              await clienteRef.transaction(current => {
                // Si el nodo no existe → current === null
                if (current === null) {
                  current = {
                    nombre: data.nombre,
                    celular: data.celular,
                    citas: [],
                    requiereDiagnostico: false   // o true si es diagnóstico, pero ya lo manejas después
                  };
                }

                // Aseguramos que citas sea un array (por si está corrupto o mal formado)
                if (!Array.isArray(current.citas)) {
                  current.citas = [];
                }

                current.citas.push(citaData);
                return current;
              });

              if (data.servicio.nombre === "Diagnóstico") {
                await clienteRef.update({ requiereDiagnostico: false });
              }

              const fechaCita = new Date(horaSel.inicioISO);
              await sendAdmin(
                `🎉 *Cita creada exitosamente desde admin!*\n\n` +
                `Cliente: ${data.nombre} (${data.cedula})\n` +
                `Celular: ${data.celular}\n` +
                `Servicio: ${data.servicio.nombre}\n` +
                `Estilista: ${data.empleado.nombre}\n` +
                `Fecha: ${formatearFecha(fechaCita)}\n` +
                `Hora: ${horaSel.label}\n\n` +
                `Recordatorio programado para la clienta.`
              );

              // Notificación al grupo (ya lo hace programarRecordatorio, pero reforzamos)
              const msgGrupo = `🔔 *Cita agendada desde admin*\n\n` +
                              `Cliente: ${data.nombre} (${data.cedula})\n` +
                              `Servicio: ${data.servicio.nombre}\n` +
                              `Estilista: ${data.empleado.nombre}\n` +
                              `Fecha: ${formatearFecha(fechaCita)} ${fechaCita.toLocaleTimeString("es-CO", {hour:'2-digit', minute:'2-digit'})}\n\n` +
                              `¡Preparar todo! ✨`;
              await sock.sendMessage(GROUP_ID, { text: msgGrupo });

              // Programar recordatorio a clienta
              const numeroCliente = `57${data.celular}@s.whatsapp.net`;
              programarRecordatorio(sock, numeroCliente, citaData, {
                nombre: data.nombre,
                cedula: data.cedula,
                celular: data.celular
              });

              // Limpiar estado
              adminState[groupId].mode = 'main';
              adminState[groupId].data = {};
            } catch (err) {
              console.error("Error creando cita desde admin:", err);
              await sendAdmin("❌ Error al crear la cita. Revisa logs.");
            }
            return;
          }

          // Si llegó aquí y no manejó → error genérico
          await sendAdmin("Modo no reconocido en agendamiento. Escribe MENU para salir.");
          adminState[groupId].mode = 'main';
          return;
        }

        // ── CANCELAR CITA - Selección ───────────────────────────────────────────────────
        if (currentMode === 'cancel_select') {
          if (/^\d+$/.test(text)) {
            const idx = parseInt(text) - 1;
            const todas = await obtenerTodasCitasFuturas();

            if (idx < 0 || idx >= todas.length) {
              await sendAdmin(`Número inválido. Elige entre 1 y ${todas.length}.\nEscribe MENU para volver.`);
              return;
            }

            const cita = todas[idx];
            adminState[groupId].data = { citaToCancel: cita };

            adminState[groupId].mode = 'cancel_confirm';

            const fecha = new Date(cita.inicio);
            const confirmTxt = 
              `⚠️ *¿REALMENTE DESEAS CANCELAR ESTA CITA?*\n\n` +
              `Cliente: ${cita.nombre} (${cita.cedula})\n` +
              `Servicio: ${cita.servicio}\n` +
              `Estilista: ${cita.empleado}\n` +
              `Fecha y hora: ${formatearFecha(fecha)} ${fecha.toLocaleTimeString("es-CO", {hour:'2-digit', minute:'2-digit'})}\n\n` +
              `Escribe **SI** para confirmar la cancelación\n` +
              `Escribe cualquier otra cosa o MENU para cancelar esta acción`;

            await sendAdmin(confirmTxt);
            return;
          }

          await sendAdmin("Escribe solo el número de la cita que quieres cancelar\nO MENU para volver.");
          return;
        }

        // ── CANCELAR CITA - Confirmación ────────────────────────────────────────────────
        if (currentMode === 'cancel_confirm') {
          if (["SI", "SÍ"].includes(textUpper)) {
            const cita = adminState[groupId].data.citaToCancel;

            try {
              if (cita.eventId) {
                await eliminarEvento(cita.eventId, cita.empleado);
                if (recordatoriosActivos[cita.eventId]) {
                  clearTimeout(recordatoriosActivos[cita.eventId]);
                  delete recordatoriosActivos[cita.eventId];
                }
              }

              const clienteRef = db.ref(`clientes/${cita.cedula}`);
              await clienteRef.transaction(current => {
                if (!current?.citas) return current;
                current.citas = current.citas.filter(c => 
                  !(c.inicio === cita.inicio && c.empleado === cita.empleado)
                );
                return current;
              });

              if (cita.servicio === "Diagnóstico") {
                await clienteRef.update({ requiereDiagnostico: true });
              }

              if (cita.celular) {
                const numero = `57${cita.celular}@s.whatsapp.net`;
                const fechaCita = new Date(cita.inicio);
                await sock.sendMessage(numero, { 
                  text: `❌ *Tu cita ha sido CANCELADA por el salón*\n\n` +
                        `Servicio: ${cita.servicio}\n` +
                        `Estilista: ${cita.empleado}\n` +
                        `Fecha: ${formatearFecha(fechaCita)}\n` +
                        `Lamentamos el inconveniente. Puedes agendar nuevamente escribiendo 1.\n💖 Porque Tú Eres Bella`
                });
              }

              await sendAdmin(
                `✅ Cita cancelada exitosamente.\n` +
                `Cliente: ${cita.nombre} (${cita.cedula})\n` +
                `Servicio: ${cita.servicio} con ${cita.empleado}\n\n` +
                `Escribe MENU para volver.`
              );
            } catch (err) {
              console.error("Error al cancelar desde menú admin:", err);
              await sendAdmin("❌ Error al cancelar la cita. Revisa los logs.");
            }

            adminState[groupId].mode = 'main';
            adminState[groupId].data = {};
            return;
          }

          // Cualquier otra respuesta ≠ SI
          await sendAdmin("Acción cancelada.\n\nEscribe MENU para volver al menú principal.");
          adminState[groupId].mode = 'main';
          adminState[groupId].data = {};
          return;
        }

        // ── BLOQUEAR AGENDA - Selección de quién ────────────────────────────────────────
        if (currentMode === 'block_who') {
          if (['1','2','3'].includes(text)) {
            adminState[groupId].data = {
              empleados: text === '1' ? ['Carlos'] :
                        text === '2' ? ['Arturo'] :
                        ['Carlos', 'Arturo']
            };
            adminState[groupId].mode = 'block_date';

            await sendAdmin(
              `📅 *Fecha del bloqueo*\n\n` +
              `Escribe la fecha en formato YYYY-MM-DD\n` +
              `Ejemplo: 2025-04-15\n\n` +
              `o escribe MENU para volver`
            );
            return;
          }

          await sendAdmin("Por favor escribe 1, 2 o 3 (o MENU para volver).");
          return;
        }

        // ── BLOQUEAR AGENDA - Fecha ─────────────────────────────────────────────────────
        if (currentMode === 'block_date') {
          if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
            adminState[groupId].data.fecha = text;
            adminState[groupId].mode = 'block_type';

            await sendAdmin(
              `⏰ *Tipo de bloqueo para ${text}*\n\n` +
              `1️⃣ Todo el día\n` +
              `2️⃣ Rango horario específico\n\n` +
              `Escribe 1 o 2 (o MENU para volver)`
            );
            return;
          }

          await sendAdmin("Formato de fecha incorrecto. Usa YYYY-MM-DD\nEjemplo: 2025-04-15\nO MENU para volver.");
          return; 
        }

        // ── BLOQUEAR AGENDA - Tipo ──────────────────────────────────────────────────────
        if (currentMode === 'block_type') {
          if (text === '1') {
            adminState[groupId].data.horaInicio = "07:00";
            adminState[groupId].data.horaFin = "19:00";
            adminState[groupId].mode = 'block_confirm';
            await sendAdmin(
              `🕐 Deseas crear este bloqueo de agenda?\n\n` +
              'Vas a bloquear el dia ' + adminState[groupId].data.fecha + '\n' +
              'Escribe "SI" para confirmar o "NO" para cancelar'
            )

            return;
          } else if (text === '2') {
            adminState[groupId].mode = 'block_range';
            await sendAdmin(
              `🕐 *Rango horario*\n\n` +
              `Escribe la hora de INICIO y FIN separadas por espacio\n` +
              `Formato: HH:MM HH:MM\n` +
              `Ejemplo: 09:30 13:45\n\n` +
              `o escribe MENU para volver`
            );
            return;
          } else {
            await sendAdmin("Por favor escribe 1 o 2 (o MENU para volver).");
            return;
          }
        }

        // ── BLOQUEAR AGENDA - Rango horario ─────────────────────────────────────────────
        if (currentMode === 'block_range') {
          if (text.includes(" ")) {
            const [ini, fin] = text.split(" ").map(t => t.trim());
            if (/^\d{2}:\d{2}$/.test(ini) && /^\d{2}:\d{2}$/.test(fin)) {
              adminState[groupId].data.horaInicio = ini;
              adminState[groupId].data.horaFin = fin;
              adminState[groupId].mode = 'block_confirm';
              
              await sendAdmin(
                `🕐 Deseas crear este bloqueo de agenda?\n\n` +
                'Vas a bloquear el dia ' + adminState[groupId].data.fecha + '\n' +
                'Desde las ' + adminState[groupId].data.horaInicio + ' hasta las ' + adminState[groupId].data.horaFin + '\n' + 
                'Escribe "SI" para confirmar o "NO" para cancelar'
              )

              return;
            } else {
              await sendAdmin("Formato incorrecto. Usa HH:MM HH:MM\nEjemplo: 09:30 14:00\nO MENU para volver.");
              return;
            }
          } else {
            await sendAdmin("Debes escribir dos horas separadas por espacio.\nO MENU para volver.");
            return;
          }
        }

        // ── BLOQUEAR AGENDA - Confirmación final ─────────────────────────────────────

        if (currentMode === 'block_confirm') {
          if (["SI", "SÍ"].includes(textUpper)) {
            const d = adminState[groupId].data;
            
            console.log(`[BLOCK] Intentando bloquear fecha: ${d.fecha}, rango: ${d.horaInicio}-${d.horaFin}, empleados: ${d.empleados.join(', ')}`);
            
            // === FECHA PARA COMPARAR CONFLICTOS (le sumamos +1 día porque así se guardan en DB/Google) ===
            const fechaComparacion = new Date(d.fecha);
            fechaComparacion.setDate(fechaComparacion.getDate() + 1); // ← Aquí se suma el día
            console.log(`[BLOCK] Fecha usada para comparar conflictos (con +1 día): ${fechaComparacion.toISOString().split('T')[0]}`);
            
            // Parse del rango de bloqueo
            const [blockHIni, blockMIni] = d.horaInicio.split(":").map(Number);
            const [blockHFin, blockMFin] = d.horaFin.split(":").map(Number);
            
            const blockStart = new Date(fechaComparacion);
            blockStart.setHours(blockHIni, blockMIni, 0, 0);
            
            const blockEnd = new Date(fechaComparacion);
            blockEnd.setHours(blockHFin, blockMFin, 0, 0);
            
            console.log(`[BLOCK] Rango de bloqueo (con +1 día): ${blockStart.toISOString()} → ${blockEnd.toISOString()}`);
            
            const todas = await obtenerTodasCitasFuturas();
            const conflictingCitas = [];
            
            todas.forEach(c => {
              const citaDate = new Date(c.inicio);
              
              // Solo miramos citas del mismo día (con el +1 día aplicado)
              if (citaDate.toDateString() !== fechaComparacion.toDateString()) return;
              if (!d.empleados.includes(c.empleado)) return;
              
              // Calcular fin de la cita
              const duracionCita = c.duracionHoras || serviciosPorNombre[c.servicio?.toUpperCase()]?.duracion || 1;
              const citaEnd = new Date(citaDate.getTime() + duracionCita * 3600000);
              
              const overlaps = citaDate < blockEnd && citaEnd > blockStart;
              
              if (overlaps) {
                console.log(`[BLOCK] CONFLICTO → ${c.nombre} (${c.cedula}) - ${c.servicio} con ${c.empleado} de ${citaDate.toISOString()} a ${citaEnd.toISOString()}`);
                conflictingCitas.push(c);
              }
            });
            
            if (conflictingCitas.length > 0) {
              let txt = "❌ No se puede crear el bloqueo: Hay citas que se superponen.\n\n";
              conflictingCitas.forEach(c => {
                const fechaCita = new Date(c.inicio);
                txt += `• ${c.nombre} (${c.cedula}) - ${c.servicio} con ${c.empleado} a las ${fechaCita.toLocaleTimeString('es-CO', {hour:'2-digit', minute:'2-digit'})}\n`;
              });
              txt += "\nAjusta el rango o cancela las citas primero.\nEscribe MENU para volver.";
              await sendAdmin(txt);
              adminState[groupId].mode = 'main';
              adminState[groupId].data = {};
              return;
            }
            
            console.log('[BLOCK] No hay conflictos. Procediendo a crear el bloqueo...');
            
            // === CREACIÓN DEL BLOQUEO (sin cambios, ya suma +1 día en fechaBaseDB) ===
            try {
              const fechaBase = new Date(d.fecha);
              const [hIni, mIni] = d.horaInicio.split(":").map(Number);
              const [hFin, mFin] = d.horaFin.split(":").map(Number);

              const inicioDate = new Date(fechaBase);
              inicioDate.setHours(hIni, mIni, 0, 0);

              const finDate = new Date(fechaBase);
              finDate.setHours(hFin, mFin, 0, 0);

              const duracionHoras = (finDate - inicioDate) / (3600 * 1000);

              const fechaBaseDB = new Date(fechaBase);
              fechaBaseDB.setDate(fechaBaseDB.getDate() + 1);   // ← +1 día para DB/Google Calendar

              const inicioDateDB = new Date(fechaBaseDB);
              inicioDateDB.setHours(hIni, mIni, 0, 0);

              const bloqueosCreados = [];

              for (const emp of d.empleados) {
                const eventId = await crearEvento({
                  nombre: `BLOQUEO AGENDA`,
                  servicio: "BLOQUEO",
                  empleado: emp,
                  inicioISO: inicioDateDB.toISOString(),
                  duracionHoras,
                  telefono: null,
                  cedula: "-1",
                  esCambio: false,
                  notas: `Bloqueo administrativo`
                });

                bloqueosCreados.push({
                  nombre: "BLOQUEO ADMINISTRATIVO",
                  cedula: "-1",
                  servicio: "BLOQUEO",
                  empleado: emp,
                  inicio: inicioDateDB.toISOString(),
                  fechaCreacion: new Date().toISOString(),
                  estado: "confirmada",
                  eventId,
                  recordatorioEnviado: true,
                  notas: `Bloqueo ${d.horaInicio}-${d.horaFin}`
                });
              }

              const ref = db.ref(`clientes/-1`);
              await ref.transaction(curr => {
                curr = curr || { citas: [] };
                curr.citas.push(...bloqueosCreados);
                return curr;
              });

              console.log('[BLOCK] Bloqueo creado exitosamente');

              await sendAdmin(
                `✅ Bloqueo creado exitosamente!\n\n` +
                `Empleados: ${d.empleados.join(" y ")}\n` +
                `Fecha: ${d.fecha}\n` +
                `Horario: ${d.horaInicio} – ${d.horaFin}\n\n` +
                `Escribe MENU para volver`
              );
            } catch (err) {
              console.error("Error creando bloqueo:", err);
              await sendAdmin("❌ Error al crear el bloqueo. Revisa los logs.");
            }

            adminState[groupId].mode = 'main';
            adminState[groupId].data = {};
            return;
          }

          // No dijo SI
          await sendAdmin("Bloqueo cancelado.\n\nEscribe MENU para volver al menú principal.");
          adminState[groupId].mode = 'main';
          adminState[groupId].data = {};
          return;
        }

        // ── Último caso de seguridad ────────────────────────────────────────────────────
        console.warn(`[ADMIN] Modo no manejado: ${currentMode}`);
        adminState[groupId].mode = 'main';
        adminState[groupId].data = {};
        await sendAdmin("Modo no reconocido. Volviendo al menú principal...\n\nEscribe MENU para continuar.");
        return;
      }

      // ===============================
      // INICIO - MENSAJE DE BIENVENIDA
      // ===============================
      if (!conv.estado) {
        conv.estado = "INICIO";
        await sock.sendMessage(from, { 
          text: `¡Hola! 💖 Bienvenido/a a *Porque Tú Eres Bella* ✨\n\nSomos tu salón de belleza favorito. ¿En qué podemos ayudarte hoy?\n\n*Opciones disponibles:*\n1️⃣ Agendar cita\n2️⃣ Consultar cita existente\n3️⃣ Información de servicios\n\nEscribe el número de la opción (ej: 1) \n\n Recuerda que estamos ubicados en la Carrera 19 # 70A - 31 edificio alexandra 301, Barrios Unidos, Chapinero centrar, Bogotá D.C. \n\n Si tienes dudas para agendar la cita, puedes llamar a este mismo numero y un asesor humano lo hará por ti` 
        });
        return;
      }

      // ===============================
      // COMANDOS GENERALES - MENU, AYUDA
      // ===============================
      if (["MENU", "INICIO", "PRINCIPAL", "AYUDA", "HELP"].includes(respuesta)) {
        conversaciones.delete(from);
        conv.estado = "INICIO";
        
        await sock.sendMessage(from, { 
          text: `🔙 *Menú Principal* 💖\n\n¡Hola! ✨\n\n*Opciones disponibles:*\n\n` +
                `1️⃣ Agendar cita - Programa tu próxima visita\n` +
                `2️⃣ Consultar cita - Verifica tus citas existentes\n` +
                `3️⃣ Información - Conoce nuestros servicios y estilistas\n\n` +
                `Escribe el número de la opción (ej: 1)\n\n` +
                `💡 *Comandos útiles:*\n` +
                `• Escribe 'MENU' en cualquier momento para volver aquí\n` +
                `• Escribe 'AYUDA' si necesitas asistencia \n\n Recuerda que estamos ubicados en la Carrera 19 # 70A - 31 edificio alexandra 301, Barrios Unidos, Chapinero centrar, Bogotá D.C. \n\n Si tienes dudas para agendar la cita, puedes llamar a este mismo numero y un asesor humano lo hará por ti` 
        });
        return;
      }

      // ===============================
      // INICIO
      // ===============================
      if (conv.estado === "INICIO") {
        if (["1", "AGENDAR", "CITA", "NUEVA CITA"].includes(respuesta)) {
          conv.estado = "MENU_SERVICIOS";
          const listaServicios = serviciosLista.map(s => 
            `${s.id}️⃣ ${s.nombre} - ${formatearDuracion(s.duracion)}`
          ).join('\n');
          await sock.sendMessage(from, { 
            text: `💇‍♀️ *Servicios Disponibles*\n\n${listaServicios}\n\nEscribe el número del servicio que deseas agendar (ej: 1)\n\nEscribe 'MENU' para volver al menú principal.` 
          });
          return;
        }

        if (["2", "CONSULTAR", "CITA EXISTENTE", "MIS CITAS"].includes(respuesta)) {
          conv.estado = "CONSULTAR_CEDULA";
          await sock.sendMessage(from, { 
            text: "🔍 *Consultar cita existente*\n\n🪪 Por favor, escribe tu número de cédula (solo números, ej: 12345678):\n\nEscribe 'MENU' para volver." 
          });
          return;
        }

        if (["3", "SERVICIOS", "INFORMACION", "INFO"].includes(respuesta)) {
          const textoServicios = serviciosLista.map(s => 
            `• ${s.nombre} - ${formatearDuracion(s.duracion)}: ${getDescripcionServicio(s.nombre)}`
          ).join('\n');
          
          await sock.sendMessage(from, { 
            text: `📋 *Información de nuestros servicios*\n\n${textoServicios}\n\n👥 *Nuestros estilistas:*\n• Carlos\n• Arturo\n\n💖 ¡Estamos listos para cuidarte!\n\nEscribe 'MENU' para volver al menú principal.` 
          });
          conv.estado = "INICIO";
          return;
        }

        await sock.sendMessage(from, { 
          text: `❓ No entendí tu respuesta. Por favor elige una opción:\n\n1️⃣ Agendar nueva cita\n2️⃣ Consultar cita existente\n3️⃣ Información de servicios\n\nEscribe el número (ej: 1) o 'MENU' para ver el menú. \n\n Si tienes dudas para agendar la cita, puedes llamar a este mismo numero y un asesor humano lo hará por ti` 
        });
        return;
      }

      // ===============================
      // CONSULTAR CITA EXISTENTE
      // ===============================
      if (conv.estado === "CONSULTAR_CEDULA") {
        if (!/^\d{5,}$/.test(originalText)) {
          await sock.sendMessage(from, { 
            text: "❗ Formato inválido. Por favor, escribe solo números de tu cédula (ej: 12345678)\n\nEscribe 'MENU' para volver." 
          });
          return;
        }

        const citasExistentes = await obtenerCitasExistentes(originalText);
        
        if (citasExistentes.length > 0) {
          conv.temp = { cedula: originalText, citasExistentes };
          if (citasExistentes.length === 1) {
            const cita = citasExistentes[0];
            const fechaCita = new Date(cita.inicio);
            await sock.sendMessage(from, { 
              text: `📅 *Tu cita confirmada:*\n\n👤 ${cita.nombre || 'Cliente'}\n💇‍♀️ ${cita.servicio}\n👨‍💼 ${cita.empleado}\n📅 ${formatearFecha(fechaCita)}\n🕐 ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit' })}\n\n✏️ ¿Qué deseas hacer?\n\nEscribe 'CAMBIAR' para modificar fecha/hora, 'CANCELAR' para eliminarla o 'NO' para volver al menú.` 
            });
            conv.temp.citaExistente = cita;
            conv.estado = "GESTIONAR_CITA";
          } else {
            const listaCitas = citasExistentes.map((cita, i) => {
              const fechaCita = new Date(cita.inicio);
              return `${i + 1}️⃣ ${cita.servicio} con ${cita.empleado} - ${formatearFecha(fechaCita)} a las ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit' })}`;
            }).join('\n');
            await sock.sendMessage(from, { 
              text: `📅 *Tus citas futuras:*\n\n${listaCitas}\n\nEscribe el número de la cita que deseas gestionar (ej: 1)\n\nEscribe 'MENU' para volver.` 
            });
            conv.estado = "SELECCIONAR_CITA_GESTIONAR";
          }
        } else {
          await sock.sendMessage(from, { 
            text: `❌ No encontramos citas activas con la cédula ${originalText}.\n\n¿Deseas agendar una nueva cita?\n\nEscribe 'SI' para agendar o 'NO' para volver al menú.` 
          });
          conv.estado = "CONSULTAR_NO_ENCONTRADA";
        }
        return;
      }

      // ===============================
      // SELECCIONAR CITA PARA GESTIONAR (múltiples citas)
      // ===============================
      if (conv.estado === "SELECCIONAR_CITA_GESTIONAR") {
        const indice = parseInt(respuesta) - 1;
        if (isNaN(indice) || indice < 0 || indice >= conv.temp.citasExistentes.length) {
          await sock.sendMessage(from, { text: `❗ Número inválido. Elige entre 1 y ${conv.temp.citasExistentes.length}.\n\nEscribe 'MENU' para volver.` });
          return;
        }
        const cita = conv.temp.citasExistentes[indice];
        conv.temp.citaExistente = cita;
        const fechaCita = new Date(cita.inicio);
        await sock.sendMessage(from, { 
          text: `📅 *Cita seleccionada:*\n\n👤 ${cita.nombre || 'Cliente'}\n💇‍♀️ ${cita.servicio}\n👨‍💼 ${cita.empleado}\n📅 ${formatearFecha(fechaCita)}\n🕐 ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit' })}\n\n✏️ ¿Qué deseas hacer?\n\nEscribe 'CAMBIAR' para modificar, 'CANCELAR' para eliminar o 'NO' para volver.` 
        });
        conv.estado = "GESTIONAR_CITA";
        return;
      }

      // ===============================
      // GESTIONAR CITA (CAMBIAR O CANCELAR)
      // ===============================
      if (conv.estado === "GESTIONAR_CITA") {
        const cita = conv.temp.citaExistente;
        
        if (["CAMBIAR", "SI", "1"].includes(respuesta)) {
          const servicioExistente = serviciosPorNombre[cita.servicio.toUpperCase()] || serviciosLista[0];
          conv.temp = { 
            servicio: { nombre: cita.servicio, duracion: servicioExistente.duracion },
            empleado: { nombre: cita.empleado },
            cedula: conv.temp.cedula,
            nombre: cita.nombre,
            esCambio: true,
            citaOriginal: cita
          };
          conv.estado = "CONFIRMAR_CAMBIO_TIPO";
          await sock.sendMessage(from, { 
            text: `✏️ *Modificar cita*\n\nTu cita actual: ${conv.temp.servicio.nombre} con ${conv.temp.empleado.nombre}.\n\n¿Qué deseas cambiar?\n\n1️⃣ Solo fecha/hora (mantener servicio y estilista)\n2️⃣ Servicio y/o estilista también\n\nEscribe el número (ej: 1)\n\nEscribe 'MENU' para volver.` 
          });
          return;
        }

        if (["CANCELAR", "2"].includes(respuesta)) {
          try {
            if (cita.eventId) {
              await eliminarEvento(cita.eventId, cita.empleado);
              if (recordatoriosActivos[cita.eventId]) {
                clearTimeout(recordatoriosActivos[cita.eventId]);
                delete recordatoriosActivos[cita.eventId];
              }
            }

            const clienteRef = db.ref(`clientes/${conv.temp.cedula}`);
            await clienteRef.transaction((clienteData) => {
              if (clienteData === null) return null;
              if (!clienteData.citas || !Array.isArray(clienteData.citas)) return clienteData;
              
              clienteData.citas = clienteData.citas.filter((_, idx) => idx !== cita.arrayIndex);
              return clienteData;
            });

            if (cita.servicio === "Diagnóstico") {
              await clienteRef.update({ requiereDiagnostico: true });
            }

            await sock.sendMessage(from, { 
              text: "❌ *Cita cancelada exitosamente.*\n\nSi deseas agendar una nueva, escribe '1️⃣' en el menú principal.\n\nEscribe 'MENU' para volver." 
            });

            const snap = await clienteRef.child('celular').once('value');
            const celular = snap.exists() ? snap.val() : null;

            const fechaCita = new Date(cita.inicio);
            const mensajeGrupoCancelacion = `⚠️ *CITA CANCELADA POR EL CLIENTE*\n\n` +
                                            `👤 Cliente: ${cita.nombre || 'Cliente'} (${conv.temp.cedula})\n` +
                                            `📱 ${celular ? '' + celular : 'No registrado'}\n` +
                                            `💇‍♀️ Servicio: ${cita.servicio}\n` +
                                            `👨‍💼 Estilista: ${cita.empleado}\n` +
                                            `📅 Fecha: ${formatearFecha(fechaCita)}\n` +
                                            `🕐 Hora: ${fechaCita.toLocaleTimeString("es-CO", {
                                                hour: '2-digit',
                                                minute: '2-digit'
                                              })}\n\n` +
                                            `La estación ya no necesita prepararse para esta cita.`;

            try {
              await sock.sendMessage(GROUP_ID, { text: mensajeGrupoCancelacion });
              console.log(`Notificación de cancelación por cliente enviada al grupo: ${GROUP_ID}`);
            } catch (err) {
              console.error("Error enviando notificación de cancelación al grupo:", err);
            }

          } catch (error) {
            console.error("Error cancelando cita:", error);
            await sock.sendMessage(from, { 
              text: "❌ Ocurrió un error al cancelar la cita. Por favor, intenta nuevamente o contacta al salón." 
            });
          }
          conversaciones.delete(from);
          return;
        }

        if (["NO", "3"].includes(respuesta)) {
          conversaciones.delete(from);
          await sock.sendMessage(from, { 
            text: "👌 Perfecto. Tu cita está confirmada.\n\n¡Te esperamos! 💖\n\nEscribe 'MENU' para volver al menú principal." 
          });
          return;
        }

        await sock.sendMessage(from, { 
          text: "❓ Por favor, escribe 'CAMBIAR', 'CANCELAR' o 'NO'." 
        });
        return;
      }

      // ===============================
      // CONFIRMAR TIPO DE CAMBIO
      // ===============================
      if (conv.estado === "CONFIRMAR_CAMBIO_TIPO") {
        if (["1"].includes(respuesta)) {
          conv.estado = "CONFIRMAR_CLIENTE";
          await sock.sendMessage(from, { 
            text: `👌 Mantendremos el servicio (${conv.temp.servicio.nombre}) y estilista (${conv.temp.empleado.nombre}).\n\nAhora, busquemos una nueva fecha/hora.\n\nEscribe 'SI' para continuar o 'MENU' para volver.` 
          });
          return;
        } else if (["2"].includes(respuesta)) {
          conv.estado = "MENU_SERVICIOS_CAMBIO";
          const listaServicios = serviciosLista.map(s => 
            `${s.id}️⃣ ${s.nombre} - ${formatearDuracion(s.duracion)}`
          ).join('\n');
          await sock.sendMessage(from, { 
            text: `💇‍♀️ *Cambiar servicio*\n\nSelecciona el nuevo servicio (o el mismo para mantener):\n\n${listaServicios}\n\nEscribe el número (ej: 1)\n\nEscribe 'MENU' para volver.` 
          });
          return;
        }
        await sock.sendMessage(from, { 
          text: "❓ Por favor, escribe '1' o '2'." 
        });
        return;
      }

      // ===============================
      // CITA NO ENCONTRADA
      // ===============================
      if (conv.estado === "CONSULTAR_NO_ENCONTRADA") {
        if (["SI", "SÍ", "1"].includes(respuesta)) {
          conv.estado = "MENU_SERVICIOS";
          const listaServicios = serviciosLista.map(s => 
            `${s.id}️⃣ ${s.nombre} - ${formatearDuracion(s.duracion)}`
          ).join('\n');
          await sock.sendMessage(from, { 
            text: `💇‍♀️ *Servicios Disponibles*\n\n${listaServicios}\n\nEscribe el número del servicio (ej: 1)\n\nEscribe 'MENU' para volver.` 
          });
          return;
        }

        if (["NO", "2"].includes(respuesta)) {
          conversaciones.delete(from);
          await sock.sendMessage(from, { 
            text: "👌 Entendido. ¡Cuando desees agendar, escríbenos!\n\nEscribe 'MENU' para volver al menú principal." 
          });
          return;
        }

        await sock.sendMessage(from, { 
          text: "❓ Por favor, escribe 'SI' o 'NO'." 
        });
        return;
      }

      // ===============================
      // SELECCIÓN DE SERVICIO (nueva cita o cambio)
      // ===============================
      if (conv.estado === "MENU_SERVICIOS" || conv.estado === "MENU_SERVICIOS_CAMBIO") {
        const servicioSeleccionado = serviciosLista.find(s => s.id === respuesta);
        if (!servicioSeleccionado) {
          await sock.sendMessage(from, { 
            text: "❗ Número de servicio no válido. Por favor escribe un número del 1 al 6.\n\nEscribe 'MENU' para volver." 
          });
          return;
        }

        conv.temp = { 
          ...conv.temp,
          servicio: { nombre: servicioSeleccionado.nombre, duracion: servicioSeleccionado.duracion },
          esCambio: conv.estado === "MENU_SERVICIOS_CAMBIO"
        };
        
        conv.estado = "SELECCION_EMPLEADO";
        
        const listaEmpleados = empleadosLista.map(e => 
          `${e.id}️⃣ ${e.nombre}`
        ).join('\n');
        
        await sock.sendMessage(from, { 
          text: `👨‍💼 *Seleccionar Estilista*\n\n¿Con cuál de nuestros estilistas deseas tu cita?\n\n${listaEmpleados}\n\nEscribe el número (ej: 1)\n\nEscribe 'MENU' para volver.` 
        });
        return;
      }

      // ===============================
      // SELECCIÓN DE EMPLEADO
      // ===============================
      if (conv.estado === "SELECCION_EMPLEADO") {
        const empleadoSeleccionado = empleadosLista.find(e => e.id === respuesta);
        if (!empleadoSeleccionado) {
          await sock.sendMessage(from, { 
            text: "❗ Número de estilista no válido. Por favor escribe 1 o 2.\n\nEscribe 'MENU' para volver." 
          });
          return;
        }

        conv.temp.empleado = { nombre: empleadoSeleccionado.nombre };
        conv.estado = "INGRESAR_CEDULA";
        
        await sock.sendMessage(from, { 
          text: `✨ *¡Excelente elección!* ${conv.temp.empleado.nombre} es uno de nuestros mejores estilistas.\n\n🪪 Ahora, para continuar con tu cita de *${conv.temp.servicio.nombre}*, por favor escribe tu número de cédula (solo números, ej: 12345678):\n\nEscribe 'MENU' para volver.` 
        });
        return;
      }

      // ===============================
      // INGRESAR CÉDULA
      // ===============================
      if (conv.estado === "INGRESAR_CEDULA") {
        if (!/^\d{5,}$/.test(originalText)) {
          await sock.sendMessage(from, { 
            text: "❗ Formato inválido. Por favor, escribe solo números de tu cédula (ej: 12345678)\n\nEscribe 'MENU' para volver." 
          });
          return;
        }

        conv.temp.cedula = originalText;
        
        const hasPendingDiagnosis = await tieneDiagnosticoPendiente(originalText);
        if (hasPendingDiagnosis) {
          await sock.sendMessage(from, { 
            text: "❌ Lo sentimos, tienes una cita de *Diagnóstico* pendiente. Debes completarla antes de poder agendar otros servicios.\n\nPor favor, consulta tus citas existentes escribiendo '2️⃣' en el menú principal.\n\nEscribe 'MENU' para volver." 
          });
          conv.estado = "INICIO";
          return;
        }
        
        const clienteRef = db.ref(`clientes/${originalText}`);
        const snap = await clienteRef.once('value');
        
        if (!snap.exists()) {
          conv.estado = "CONFIRMAR_ES_NUEVO";
          await sock.sendMessage(from, { 
            text: `👋 Según nuestro registro, no tenemos información de esta cédula.\n\n¿Eres realmente un cliente **nuevo** de *Porque Tú Eres Bella* y nunca has tenido un diagnóstico con nosotros? Escribe 'SI' para confirmar que eres nuevo o 'NO' si ya has sido cliente anteriormente.` 
          });
        } else {
          const clienteData = snap.val();
          conv.temp.nombre = clienteData.nombre || "Cliente";

          if (clienteData.requiereDiagnostico === true && conv.temp.servicio.nombre !== "Diagnóstico") {
            await sock.sendMessage(from, { 
              text: "⚠️ Según nuestro registro, aún necesitas realizar tu *Diagnóstico* inicial.\n\nEstamos ajustando tu cita a Diagnóstico para poder continuar con los demás servicios." 
            });
            const diag = serviciosLista.find(s => s.id === '6');
            conv.temp.servicio = { nombre: diag.nombre, duracion: diag.duracion };
          }

          conv.estado = "INGRESAR_CELULAR";
          await sock.sendMessage(from, { 
            text: `¡Hola ${conv.temp.nombre}! 😊\n\n📱 Por favor, escribe tu número de celular (10 dígitos, ej: 3001234567) para confirmar o actualizar:\n\nEscribe 'MENU' para volver.` 
          });
        }
        return;
      }

      // ===============================
      // CONFIRMAR SI ES NUEVO
      // ===============================
      if (conv.estado === "CONFIRMAR_ES_NUEVO") {
        if (["SI", "SÍ"].includes(respuesta)) {
          if (conv.temp.servicio.nombre !== "Diagnóstico") {
            await sock.sendMessage(from, { 
              text: "👋 ¡Perfecto! Como eres un cliente nuevo, es **obligatorio** realizar un *Diagnóstico* inicial para evaluar tu cabello y recomendar el mejor servicio.\n\nEstamos ajustando tu cita a Diagnóstico." 
            });
            const diag = serviciosLista.find(s => s.id === '6');
            conv.temp.servicio = { nombre: diag.nombre, duracion: diag.duracion };
          }

          conv.estado = "INGRESAR_NOMBRE";
          await sock.sendMessage(from, { 
            text: `👋 ¡Bienvenido/a nuevo cliente!\n\n✍️ Para completar tu registro, escribe tu nombre completo:\n\nEscribe 'MENU' para volver.` 
          });
        } 
        else if (["NO"].includes(respuesta)) {
          conv.estado = "INGRESAR_NOMBRE_EXISTENTE";
          await sock.sendMessage(from, { 
            text: "Entendido. Como indicas que ya has sido cliente anteriormente, continuaremos con el servicio que seleccionaste.\n\nPara mantener tu información actualizada, por favor escribe tu nombre completo:" 
          });
        } 
        else {
          await sock.sendMessage(from, { 
            text: "❓ Por favor, escribe 'SI' o 'NO'." 
          });
          return;
        }
        return;
      }

      // ===============================
      // INGRESAR NOMBRE (nuevo)
      // ===============================
      if (conv.estado === "INGRESAR_NOMBRE") {
        if (originalText.trim().length < 2) {
          await sock.sendMessage(from, { 
            text: "❗ Por favor, escribe un nombre válido (mínimo 2 caracteres).\n\nEscribe 'MENU' para volver." 
          });
          return;
        }

        conv.temp.nombre = originalText.trim();
        conv.estado = "INGRESAR_CELULAR";
        
        await sock.sendMessage(from, { 
          text: `¡Hola ${conv.temp.nombre}! 👋\n\n📱 Ahora, para mantenerte al tanto de tu cita, escribe tu número de celular (10 dígitos, ej: 3001234567):\n\nEscribe 'MENU' para volver.` 
        });
        return;
      }

      // ===============================
      // INGRESAR NOMBRE (existente que dijo NO ser nuevo)
      // ===============================
      if (conv.estado === "INGRESAR_NOMBRE_EXISTENTE") {
        if (originalText.trim().length < 2) {
          await sock.sendMessage(from, { 
            text: "❗ Por favor, escribe un nombre válido (mínimo 2 caracteres).\n\nEscribe 'MENU' para volver." 
          });
          return;
        }

        conv.temp.nombre = originalText.trim();
        conv.estado = "INGRESAR_CELULAR";
        
        await sock.sendMessage(from, { 
          text: `¡Hola ${conv.temp.nombre}! 👋\n\n📱 Ahora, para mantener tu información actualizada, escribe tu número de celular (10 dígitos, ej: 3001234567):\n\nEscribe 'MENU' para volver.` 
        });
        return;
      }

      // ===============================
      // INGRESAR CELULAR
      // ===============================
      if (conv.estado === "INGRESAR_CELULAR") {
        if (!/^\d{10}$/.test(originalText)) {
          await sock.sendMessage(from, { 
            text: "❗ Formato inválido. Por favor, escribe un número de celular válido de 10 dígitos (ej: 3001234567)\n\nEscribe 'MENU' para volver." 
          });
          return;
        }

        conv.temp.celular = originalText;

        const clienteRef = db.ref(`clientes/${conv.temp.cedula}`);
        const snap = await clienteRef.once('value');

        if (snap.exists()) {
          if (snap.val().celular !== originalText) {
            await clienteRef.update({ celular: originalText });
          }
        } else {
          await clienteRef.set({
            nombre: conv.temp.nombre,
            celular: conv.temp.celular,
            citas: [],
            requiereDiagnostico: conv.temp.servicio.nombre === "Diagnóstico"
          });
        }

        conv.estado = "CONFIRMAR_CLIENTE";
        
        await sock.sendMessage(from, { 
          text: `¡Hola ${conv.temp.nombre}! 😊\n\nHemos registrado/actualizado tu información correctamente.\n\n¿Continuamos con la programación de tu cita?\n\n💇‍♀️ *Servicio:* ${conv.temp.servicio.nombre}\n👨‍💼 *Estilista:* ${conv.temp.empleado.nombre}\n📱 *Celular:* ${conv.temp.celular}\n\nEscribe 'SI' para agendar, 'NO' para cambiar o 'MENU' para volver.` 
        });
        return;
      }

      // ===============================
      // CONFIRMAR INFORMACIÓN DEL CLIENTE
      // ===============================
      if (conv.estado === "CONFIRMAR_CLIENTE") {
        if (["NO"].includes(respuesta)) {
          conv.estado = "MENU_SERVICIOS";
          const listaServicios = serviciosLista.map(s => 
            `${s.id}️⃣ ${s.nombre} - ${formatearDuracion(s.duracion)}`
          ).join('\n');
          await sock.sendMessage(from, { 
            text: `💇‍♀️ *Servicios Disponibles*\n\n${listaServicios}\n\nEscribe el número del servicio (ej: 1)\n\nEscribe 'MENU' para volver.` 
          });
          return;
        }

        if (["MENU"].includes(respuesta)) {
          conversaciones.delete(from);
          conv.estado = "INICIO";
          await sock.sendMessage(from, { 
            text: `🔙 *Menú principal*\n\n¡Hola de nuevo! 💖\n\nEscribe:\n1️⃣ para agendar cita\n2️⃣ para consultar cita\n3️⃣ para información` 
          });
          return;
        }

        if (["SI", "SÍ"].includes(respuesta)) {
          try {
            const meses = obtenerMesesProximos(4);
    
            let texto = `📅 *Selecciona el mes* para tu cita de ${conv.temp.servicio.nombre}\n\n`;
            meses.forEach(m => {
              texto += `${m.indice + 1}️⃣ ${m.nombre.charAt(0).toUpperCase() + m.nombre.slice(1)}\n`;
            });
            
            texto += "\nEscribe el número del mes (ej: 1)\nEscribe 'MENU' para volver.";
            
            await sock.sendMessage(from, { text: texto });
            conv.estado = "SELECCIONAR_MES";
            conv.temp.mesesDisponibles = meses;

          } catch (error) {
            console.error("Error obteniendo meses:", error);
            await sock.sendMessage(from, { 
              text: `❌ Ocurrió un error al buscar los siguientes meses disponibles. Por favor intenta nuevamente.\n\nEscribe 'MENU' para volver al menú principal.` 
            });
            conv.estado = "INICIO";
          }
          return;
        }

        await sock.sendMessage(from, { 
          text: "❓ Por favor, escribe 'SI', 'NO' o 'MENU'." 
        });
        return;
      }

      if (conv.estado === "SELECCIONAR_MES") {
        const idx = parseInt(respuesta) - 1;
        if (isNaN(idx) || idx < 0 || idx >= conv.temp.mesesDisponibles.length) {
          await sock.sendMessage(from, { text: "Número de mes inválido. Elige entre 1 y 4.\nEscribe MENU para volver." });
          return;
        }

        const mesElegido = conv.temp.mesesDisponibles[idx];
        conv.temp.mesSeleccionado = mesElegido;

        const ahora = new Date();
        const hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 0, 0, 0);

        const primerDiaMes = new Date(mesElegido.year, mesElegido.mes, 1);
        const ultimoDiaMes = new Date(mesElegido.year, mesElegido.mes + 1, 0);

        // Primer lunes del mes o posterior
        let primerLunes = new Date(primerDiaMes);
        while (primerLunes.getDay() !== 0 && primerLunes <= ultimoDiaMes) {
          primerLunes.setDate(primerLunes.getDate() + 1);
        }

        const semanas = [];
        let diaActual = new Date(primerLunes);

        while (diaActual <= ultimoDiaMes) {
          const inicioSemana = new Date(diaActual);
          const finSemana = new Date(diaActual);
          finSemana.setDate(finSemana.getDate() + 6);

          // CAMBIO IMPORTANTE: incluir la semana si tiene AL MENOS UN DÍA >= mañana
          const manana = new Date(hoy);
          manana.setDate(manana.getDate() + 1);

          if (finSemana >= manana) {
            semanas.push({
              indice: semanas.length,
              inicio: inicioSemana,
              fin: finSemana,
              label: `Semana del ${inicioSemana.getDate()} al ${finSemana.getDate()} de ${inicioSemana.toLocaleDateString('es-CO', { month: 'long' })}`
            });
          }

          diaActual.setDate(diaActual.getDate() + 7);
        }

        if (semanas.length === 0) {
          await sock.sendMessage(from, { 
            text: "😔 No hay semanas con días disponibles en ese mes.\nElige otro mes o escribe MENU." 
          });
          return;
        }

        conv.temp.semanasDelMes = semanas;

        let texto = `📆 *Semanas disponibles en ${mesElegido.nombre}*\n\n`;
        semanas.forEach(s => {
          texto += `${s.indice + 1}️⃣ ${s.label}\n`;
        });

        texto += "\nEscribe el número de la semana (ej: 1)\nEscribe 'MENU' para volver o 'ATRAS' para cambiar mes.";

        await sock.sendMessage(from, { text: texto });
        conv.estado = "SELECCIONAR_SEMANA";
        return;
      }

      if (conv.estado === "SELECCIONAR_SEMANA") {
        if (["ATRAS", "VOLVER"].includes(respuesta.toUpperCase())) {
          // Volver a meses
          const meses = obtenerMesesProximos(4);
          let texto = `📅 *Selecciona el mes*\n\n`;
          meses.forEach(m => texto += `${m.indice + 1}️⃣ ${m.nombre.charAt(0).toUpperCase() + m.nombre.slice(1)}\n`);
          texto += "\nEscribe el número del mes";
          await sock.sendMessage(from, { text: texto });
          conv.estado = "SELECCIONAR_MES";
          conv.temp.mesesDisponibles = meses;
          return;
        }

        const idx = parseInt(respuesta) - 1;
        if (isNaN(idx) || idx < 0 || idx >= conv.temp.semanasDelMes.length) {
          await sock.sendMessage(from, { text: "Número de semana inválido.\nEscribe MENU o ATRAS." });
          return;
        }

        const semanaElegida = conv.temp.semanasDelMes[idx];
        conv.temp.semanaSeleccionada = semanaElegida;

        // Llamamos a obtenerHorasDisponibles con startDate para el rango exacto
        const disponiblesSemana = await obtenerHorasDisponibles({
          startDate: semanaElegida.inicio,
          dias: 7,
          duracionHoras: conv.temp.servicio.duracion,
          empleado: conv.temp.empleado.nombre
        });

        // Filtramos días dentro de la semana (seguridad adicional)
        const diasEnSemana = disponiblesSemana.filter(dia => {
          const fechaDia = new Date(dia.fechaISO);
          return fechaDia >= semanaElegida.inicio && fechaDia <= semanaElegida.fin;
        });

        if (diasEnSemana.length === 0) {
          await sock.sendMessage(from, { 
            text: "😔 No hay días con horarios disponibles en esa semana.\nPor favor elige otra semana o escribe MENU." 
          });
          return;
        }

        conv.temp.dias = diasEnSemana;
        conv.estado = "SELECCIONAR_DIA";

        let texto = `📅 *Días disponibles en la semana seleccionada*\n\n`;
        diasEnSemana.forEach((d, i) => {
          texto += `${i + 1}️⃣ ${d.fecha} (${d.slots.length} horarios)\n`;
        });

        texto += "\nEscribe el número del día";

        await sock.sendMessage(from, { text: texto });
        return;
      }

      // ===============================
      // SELECCIONAR DÍA
      // ===============================
      if (conv.estado === "SELECCIONAR_DIA") {
        const indice = parseInt(respuesta) - 1;
        
        if (isNaN(indice) || indice < 0 || indice >= conv.temp.dias.length) {
          await sock.sendMessage(from, { 
            text: `❗ Número de día no válido. Por favor escribe un número entre 1 y ${conv.temp.dias.length}.\n\nEscribe 'MENU' para volver.` 
          });
          return;
        }

        const diaSeleccionado = conv.temp.dias[indice];
        conv.temp.horas = diaSeleccionado.slots;
        conv.temp.diaSeleccionado = diaSeleccionado;
        conv.estado = "SELECCIONAR_HORA";

        const opcionesHoras = diaSeleccionado.slots.map((h, i) => 
          `${i + 1}️⃣ ${h.label}`
        ).join('\n');

        await sock.sendMessage(from, { 
          text: `🕐 *Horarios Disponibles para ${diaSeleccionado.fecha}*\n\nSelecciona la hora para tu cita de ${conv.temp.servicio.nombre} con ${conv.temp.empleado.nombre}:\n\n${opcionesHoras}\n\nEscribe el número de la hora (ej: 1)\n\nEscribe 'MENU' para volver.` 
        });
        return;
      }

      // ===============================
      // SELECCIONAR HORA → CREAR CITA
      // ===============================
      if (conv.estado === "SELECCIONAR_HORA") {
        const indice = parseInt(respuesta) - 1;
        
        if (isNaN(indice) || indice < 0 || indice >= conv.temp.horas.length) {
          await sock.sendMessage(from, { 
            text: `❗ Número de hora no válido. Por favor escribe un número entre 1 y ${conv.temp.horas.length}.\n\nEscribe 'MENU' para volver.` 
          });
          return;
        }

        const horaSeleccionada = conv.temp.horas[indice];

        // ── VERIFICACIÓN FINAL ANTES DE CREAR LA CITA ───────────────────────────────
        const sigueDisponible = await estaHoraDisponibleAhora({
            empleado: conv.temp.empleado.nombre,
            inicioISO: horaSeleccionada.inicioISO,
            duracionHoras: conv.temp.servicio.duracion
        });

        if (!sigueDisponible) {
            await sock.sendMessage(from, { 
                text: `⛔ Lo sentimos mucho, la hora *${horaSeleccionada.label}* del ${conv.temp.diaSeleccionado.fecha} ya fue tomada por otra persona mientras elegías.\n\nVamos a buscar otros horarios disponibles ahora mismo...\n\n(estamos consultando en tiempo real)`
            });

            try {
                const disponibles = await obtenerHorasDisponibles({
                    dias: 7,
                    duracionHoras: conv.temp.servicio.duracion,
                    empleado: conv.temp.empleado.nombre
                });

                if (disponibles.length === 0) {
                    await sock.sendMessage(from, { 
                        text: `😔 No encontramos más horarios disponibles en los próximos 7 días para ${conv.temp.servicio.nombre} con ${conv.temp.empleado.nombre}.\n\nTe recomendamos:\n• Intentar con otro estilista\n• Probar otro servicio\n• Volver a intentar en unas horas\n\nEscribe *MENU* para volver al inicio.`
                    });
                    conv.estado = "INICIO";
                    return;
                }

                conv.temp.dias = disponibles;
                conv.estado = "SELECCIONAR_DIA";

                const opcionesDias = disponibles.map((d, i) => 
                    `${i + 1}️⃣ ${d.fecha} (${d.slots.length} horarios disponibles)`
                ).join('\n');

                await sock.sendMessage(from, { 
                    text: `📅 *Nuevos días disponibles*\n\nLa agenda se actualizó. Elige un día para continuar con *${conv.temp.servicio.nombre}* con *${conv.temp.empleado.nombre}*:\n\n${opcionesDias}\n\nEscribe el número del día (ej: 1)\n\nEscribe *MENU* para volver al menú principal.`
                });
            } catch (error) {
                console.error("Error al reconsultar disponibilidad tras conflicto:", error);
                await sock.sendMessage(from, { 
                    text: `❌ Hubo un problema al actualizar los horarios. Por favor intenta de nuevo más tarde o escribe *MENU* para volver al inicio.`
                });
                conv.estado = "INICIO";
            }
            return;
        }

        try {
          const eventId = await crearEvento({
            nombre: `${conv.temp.nombre} (${conv.temp.cedula})`,
            servicio: conv.temp.servicio.nombre,
            empleado: conv.temp.empleado.nombre,
            inicioISO: horaSeleccionada.inicioISO,
            duracionHoras: conv.temp.servicio.duracion,
            telefono: conv.temp.celular,
            cedula: conv.temp.cedula,
            esCambio: conv.temp.esCambio ?? false
          });

          const citaData = {
            nombre: conv.temp.nombre,
            cedula: conv.temp.cedula,
            servicio: conv.temp.servicio.nombre,
            empleado: conv.temp.empleado.nombre,
            inicio: horaSeleccionada.inicioISO,
            fechaCreacion: new Date().toISOString(),
            estado: "confirmada",
            eventId: eventId,
            recordatorioEnviado: false
          };

          const clienteRef = db.ref(`clientes/${conv.temp.cedula}`);
          
          if (conv.temp.esCambio && conv.temp.citaOriginal?.eventId) {
            try {
              await eliminarEvento(conv.temp.citaOriginal.eventId, conv.temp.citaOriginal.empleado);
              if (recordatoriosActivos[conv.temp.citaOriginal.eventId]) {
                clearTimeout(recordatoriosActivos[conv.temp.citaOriginal.eventId]);
                delete recordatoriosActivos[conv.temp.citaOriginal.eventId];
              }
            } catch (e) {
              console.warn("No se pudo eliminar evento anterior", e);
            }
          }

          await clienteRef.transaction((clienteData) => {
            if (clienteData === null) {
              return { citas: [citaData] };
            }
            
            if (!clienteData.citas) {
              clienteData.citas = [];
            }

            if (conv.temp.esCambio && conv.temp.citaOriginal?.arrayIndex !== undefined) {
              clienteData.citas = clienteData.citas.filter((_, idx) => 
                idx !== conv.temp.citaOriginal.arrayIndex
              );
            }

            clienteData.citas.push(citaData);
            return clienteData;
          });

          if (conv.temp.servicio.nombre === "Diagnóstico") {
            await clienteRef.update({ requiereDiagnostico: false });
          }

          const numeroCompleto = `57${conv.temp.celular}@s.whatsapp.net`;
          programarRecordatorio(
            sock,
            numeroCompleto,
            citaData,
            { cedula: conv.temp.cedula, nombre: conv.temp.nombre, celular: conv.temp.celular }
          );

          const fechaCompleta = new Date(horaSeleccionada.inicioISO);
          await sock.sendMessage(from, { 
            text: `🎉 *¡Cita ${conv.temp.esCambio ? 'modificada' : 'confirmada'} exitosamente!* 🎉\n\n` +
                  `👤 *Cliente:* ${conv.temp.nombre}\n` +
                  `🪪 *Cédula:* ${conv.temp.cedula}\n` +
                  `💇‍♀️ *Servicio:* ${conv.temp.servicio.nombre}\n` +
                  `👨‍💼 *Estilista:* ${conv.temp.empleado.nombre}\n` +
                  `📅 *Fecha:* ${formatearFecha(fechaCompleta)}\n` +
                  `🕐 *Hora:* ${horaSeleccionada.label}\n\n` +
                  `📲 Recibirás un recordatorio 2 horas antes de tu cita.\n\n` +
                  `💖 *¡Te esperamos con mucho cariño en Porque Tú Eres Bella!*\n\n` +
                  `Si necesitas cambiar o cancelar tu cita, escribe '2️⃣' en el menú principal para consultar.\n\n` +
                  `Escribe 'MENU' para volver al menú principal.\n\n` + 
                  'Recuerda que estamos ubicados en la Carrera 19 # 70A - 31 edificio alexandra 301, Barrios Unidos, Chapinero centrar, Bogotá D.C.'
          });

          if (conv.temp.esCambio) {
            await sock.sendMessage(from, { 
              text: `✏️ *Cita actualizada correctamente.* Tu nueva cita ha reemplazado la anterior.\n\n¡Gracias por tu preferencia! 💖` 
            });
          }

          // ===============================
          // NOTIFICAR AL GRUPO
          // ===============================
          const mensajeGrupo = `🔔 *Nueva cita agendada${conv.temp.esCambio ? ' (modificada)' : ''}!*\n\n` +
                              `👤 Cliente: ${conv.temp.nombre} (${conv.temp.cedula})\n` +
                              `💇‍♀️ Servicio: ${conv.temp.servicio.nombre}\n` +
                              `👨‍💼 Estilista: ${conv.temp.empleado.nombre}\n` +
                              `📅 Fecha: ${formatearFecha(fechaCompleta)}\n` +
                              `🕐 Hora: ${horaSeleccionada.label}\n\n` +
                              `¡Preparémonos para atender con excelencia! 💖`;

          try {
            await sock.sendMessage(GROUP_ID, { text: mensajeGrupo });
            console.log(`Notificación enviada al grupo: ${GROUP_ID}`);
          } catch (err) {
            console.error("Error enviando notificación al grupo:", err);
          }

          conversaciones.delete(from);

        } catch (error) {
          console.error("Error creando/actualizando cita:", error);
          await sock.sendMessage(from, { 
            text: `❌ Ocurrió un error al confirmar tu cita. Por favor intenta nuevamente.\n\nSi el problema persiste, contacta al salón directamente.\n\nEscribe 'MENU' para volver al menú principal.` 
          });
          conv.estado = "INICIO";
        }
        return;
      }

      // ===============================
      // MENSAJE NO ENTENDIDO
      // ===============================
      await sock.sendMessage(from, { 
        text: `❓ No entendí tu mensaje "${originalText}".\n\nPor favor:\n` +
              `• Responde según las instrucciones del mensaje anterior\n` +
              `• O escribe 'MENU' para volver al menú principal\n` +
              `• O escribe 'AYUDA' para más información` 
      });
    }catch(err){
      console.error(`Error grave procesando mensaje de ${from}:`, err);
      // Opcional: avisar al usuario
      try {
        await sock.sendMessage(from, { text: "⚠️ Ups, algo salió mal por aquí. Intenta escribir de nuevo en unos segundos." });
      } catch {}
    } finally {
      release();
    }
  });
  console.log("🚀 Bot iniciado - esperando conexión...");
}

function getDescripcionServicio(nombre) {
  switch (nombre) {
    case "Balayage rubio":
      return "Técnica de coloración para un rubio natural y luminoso con decoloración.";
    case "Balayage sin decoloración":
      return "Coloración suave para un look natural sin decolorar el cabello.";
    case "Corte y peinado":
      return "Corte personalizado y estilizado para realzar tu look.";
    case "Tratamiento intensivo":
      return "Cuidado profundo para reparar y nutrir el cabello dañado.";
    case "Tratamiento disciplinante":
      return "Alisado y control del frizz para un cabello manejable.";
    case "Diagnóstico":
      return "Evaluación inicial del cabello para recomendar tratamientos personalizados.";
    default:
      return "";
  }
}

console.log("🌸 Iniciando Bot Porque Tú Eres Bella...");
startBot().catch(err => {
  console.error("Error iniciando bot:", err);
  setTimeout(startBot, 5000);
});

function obtenerMesesProximos(cantidad = 4) {
  const meses = [];
  const ahora = new Date();

  for (let i = 0; i < cantidad; i++) {
    const fecha = new Date(ahora);
    fecha.setMonth(ahora.getMonth() + i);

    meses.push({
      indice: i,
      nombre: fecha.toLocaleDateString("es-CO", { month: "long", year: "numeric" }),
      mes: fecha.getMonth(),
      year: fecha.getFullYear()
    });
  }
  return meses;
}
// ===============================
// SERVIDOR HTTP (para Render / UptimeRobot)
// ===============================
const app = express();

app.get("/", (req, res) => {
  res.status(200).send("Bot WhatsApp activo ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🌐 Servidor HTTP escuchando en puerto", PORT);
});