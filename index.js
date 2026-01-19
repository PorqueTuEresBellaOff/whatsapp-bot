// ===============================
// BOT WHATSAPP – PORQUE TÚ ERES BELLA
// Baileys ACTUAL (SOLO RESPUESTAS DE TEXTO)
// Firebase + Google Calendar
// Citas como ARRAY dentro del cliente
// ===============================
import express from "express";

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import pino from "pino"; // Logger

import { crearEvento, eliminarEvento} from "./googleCalendar.js";
import { obtenerHorasDisponibles } from "./disponibilidad.js";

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
const estados = {};
const temp = {};
const adminState = {}; // solo tendrá clave = GROUP_ID

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
  if (!cita || !cita.inicio) {
    console.warn("Intento de programar recordatorio con cita inválida:", cita);
    return;
  }
  
  const fechaCita = new Date(cita.inicio);
  const ahora = new Date();

  if (fechaCita <= ahora) return;
  if (cita.recordatorioEnviado === true) return;

  // ── 2 horas antes ────────────────────────────────
  const dosHorasAntes = new Date(fechaCita.getTime() - 2 * 60 * 60 * 1000);
  const faltanMenosDe2Horas = ahora >= dosHorasAntes;

  const delay = faltanMenosDe2Horas 
    ? 30000  // ~30 segundos si ya está muy cerca
    : dosHorasAntes.getTime() - ahora.getTime();

  if (delay <= 0) return;

  setTimeout(async () => {
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
                        `¡Por favor ven con tiempo! Te esperamos con cariño 💖`;
      } else {
        mensajeCliente = `⏰ *Recordatorio de cita* (2 horas antes)\n\n` +
                        `💇‍♀️ *${cita.servicio}* con ${cita.empleado}\n` +
                        `📅 ${formatearFecha(fechaCita)}\n` +
                        `🕐 ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit', hour12: true })}\n\n` +
                        `¡Te esperamos! 💖`;
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

    } catch (err) {
      console.error("Error enviando recordatorios (cliente/grupo):", err);
    }
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

        const numeroCompleto = `57${cliente.celular}@s.whatsapp.net`;

        programarRecordatorio(sock, numeroCompleto, cita, { ...cliente, cedula });
        programados++;
      });
    });

    console.log(`Se programaron ${programados} recordatorios pendientes.`);
  } catch (err) {
    console.error("Error reprogramando recordatorios:", err);
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
    } else if (connection === "close") {
      console.log("❌ Bot desconectado, reconectando...");
      setTimeout(startBot, 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    console.log("ID del remitente:", from);

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
      BLOCK_CONFIRM: 'block_confirm'
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
          `4️⃣ Ayuda rápida\n\n` +
          `Escribe solo el número (1-4)\n` +
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

      // ── BLOQUEAR AGENDA - Confirmación final ────────────────────────────────────────
      if (currentMode === 'block_confirm') {
        const d = adminState[groupId].data;
        const empleadosTxt = d.empleados.length === 2 ? "Carlos y Arturo" : d.empleados[0];

        if (["SI", "SÍ"].includes(textUpper)) {
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
            fechaBaseDB.setDate(fechaBaseDB.getDate() + 1);   // ← +1 día SOLO para DB

            const inicioDateDB = new Date(fechaBaseDB);
            inicioDateDB.setHours(hIni, mIni, 0, 0);

            // (finDateDB no es estrictamente necesario si solo guardas inicio, pero por consistencia)
            const finDateDB = new Date(fechaBaseDB);
            finDateDB.setHours(hFin, mFin, 0, 0);

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

            await sendAdmin(
              `✅ Bloqueo creado exitosamente!\n\n` +
              `Empleados: ${d.empleados.join(" y ")}\n` +
              `Fecha: ${d.fecha}\n` +
              `Horario: ${d.horaInicio} – ${d.horaFin}\n\n` +
              `Escribe MENU para volver`
            );
          } catch (err) {
            console.error("Error creando bloqueo desde menú:", err);
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
    // INICIO - MENSAJE DE BIENV  ENIDA
    // ===============================
    if (!estados[from]) {
      estados[from] = "INICIO";
      await sock.sendMessage(from, { 
        text: `¡Hola! 💖 Bienvenido/a a *Porque Tú Eres Bella* ✨\n\nSomos tu salón de belleza favorito. ¿En qué podemos ayudarte hoy?\n\n*Opciones disponibles:*\n1️⃣ Agendar cita\n2️⃣ Consultar cita existente\n3️⃣ Información de servicios\n\nEscribe el número de la opción (ej: 1)` 
      });
      return;
    }

    // ===============================
    // COMANDOS GENERALES - MENU, AYUDA
    // ===============================
    if (["MENU", "INICIO", "PRINCIPAL", "AYUDA", "HELP"].includes(respuesta)) {
      delete estados[from];
      delete temp[from];
      estados[from] = "INICIO";
      
      await sock.sendMessage(from, { 
        text: `🔙 *Menú Principal* 💖\n\n¡Hola! ✨\n\n*Opciones disponibles:*\n\n` +
              `1️⃣ Agendar cita - Programa tu próxima visita\n` +
              `2️⃣ Consultar cita - Verifica tus citas existentes\n` +
              `3️⃣ Información - Conoce nuestros servicios y estilistas\n\n` +
              `Escribe el número de la opción (ej: 1)\n\n` +
              `💡 *Comandos útiles:*\n` +
              `• Escribe 'MENU' en cualquier momento para volver aquí\n` +
              `• Escribe 'AYUDA' si necesitas asistencia` 
      });
      return;
    }

    // ===============================
    // INICIO
    // ===============================
    if (estados[from] === "INICIO") {
      if (["1", "AGENDAR", "CITA", "NUEVA CITA"].includes(respuesta)) {
        estados[from] = "MENU_SERVICIOS";
        const listaServicios = serviciosLista.map(s => 
          `${s.id}️⃣ ${s.nombre} - ${formatearDuracion(s.duracion)}`
        ).join('\n');
        await sock.sendMessage(from, { 
          text: `💇‍♀️ *Servicios Disponibles*\n\n${listaServicios}\n\nEscribe el número del servicio que deseas agendar (ej: 1)\n\nEscribe 'MENU' para volver al menú principal.` 
        });
        return;
      }

      if (["2", "CONSULTAR", "CITA EXISTENTE", "MIS CITAS"].includes(respuesta)) {
        estados[from] = "CONSULTAR_CEDULA";
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
        estados[from] = "INICIO";
        return;
      }

      await sock.sendMessage(from, { 
        text: `❓ No entendí tu respuesta. Por favor elige una opción:\n\n1️⃣ Agendar nueva cita\n2️⃣ Consultar cita existente\n3️⃣ Información de servicios\n\nEscribe el número (ej: 1) o 'MENU' para ver el menú.` 
      });
      return;
    }

    // ===============================
    // CONSULTAR CITA EXISTENTE
    // ===============================
    if (estados[from] === "CONSULTAR_CEDULA") {
      if (!/^\d{5,}$/.test(originalText)) {
        await sock.sendMessage(from, { 
          text: "❗ Formato inválido. Por favor, escribe solo números de tu cédula (ej: 12345678)\n\nEscribe 'MENU' para volver." 
        });
        return;
      }

      const citasExistentes = await obtenerCitasExistentes(originalText);
      
      if (citasExistentes.length > 0) {
        temp[from] = { cedula: originalText, citasExistentes };
        if (citasExistentes.length === 1) {
          const cita = citasExistentes[0];
          const fechaCita = new Date(cita.inicio);
          await sock.sendMessage(from, { 
            text: `📅 *Tu cita confirmada:*\n\n👤 ${cita.nombre || 'Cliente'}\n💇‍♀️ ${cita.servicio}\n👨‍💼 ${cita.empleado}\n📅 ${formatearFecha(fechaCita)}\n🕐 ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit' })}\n\n✏️ ¿Qué deseas hacer?\n\nEscribe 'CAMBIAR' para modificar fecha/hora, 'CANCELAR' para eliminarla o 'NO' para volver al menú.` 
          });
          temp[from].citaExistente = cita;
          estados[from] = "GESTIONAR_CITA";
        } else {
          const listaCitas = citasExistentes.map((cita, i) => {
            const fechaCita = new Date(cita.inicio);
            return `${i + 1}️⃣ ${cita.servicio} con ${cita.empleado} - ${formatearFecha(fechaCita)} a las ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit' })}`;
          }).join('\n');
          await sock.sendMessage(from, { 
            text: `📅 *Tus citas futuras:*\n\n${listaCitas}\n\nEscribe el número de la cita que deseas gestionar (ej: 1)\n\nEscribe 'MENU' para volver.` 
          });
          estados[from] = "SELECCIONAR_CITA_GESTIONAR";
        }
      } else {
        await sock.sendMessage(from, { 
          text: `❌ No encontramos citas activas con la cédula ${originalText}.\n\n¿Deseas agendar una nueva cita?\n\nEscribe 'SI' para agendar o 'NO' para volver al menú.` 
        });
        estados[from] = "CONSULTAR_NO_ENCONTRADA";
      }
      return;
    }

    // ===============================
    // SELECCIONAR CITA PARA GESTIONAR (múltiples citas)
    // ===============================
    if (estados[from] === "SELECCIONAR_CITA_GESTIONAR") {
      const indice = parseInt(respuesta) - 1;
      if (isNaN(indice) || indice < 0 || indice >= temp[from].citasExistentes.length) {
        await sock.sendMessage(from, { text: `❗ Número inválido. Elige entre 1 y ${temp[from].citasExistentes.length}.\n\nEscribe 'MENU' para volver.` });
        return;
      }
      const cita = temp[from].citasExistentes[indice];
      temp[from].citaExistente = cita;
      const fechaCita = new Date(cita.inicio);
      await sock.sendMessage(from, { 
        text: `📅 *Cita seleccionada:*\n\n👤 ${cita.nombre || 'Cliente'}\n💇‍♀️ ${cita.servicio}\n👨‍💼 ${cita.empleado}\n📅 ${formatearFecha(fechaCita)}\n🕐 ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit' })}\n\n✏️ ¿Qué deseas hacer?\n\nEscribe 'CAMBIAR' para modificar, 'CANCELAR' para eliminar o 'NO' para volver.` 
      });
      estados[from] = "GESTIONAR_CITA";
      return;
    }

    // ===============================
    // GESTIONAR CITA (CAMBIAR O CANCELAR)
    // ===============================
    if (estados[from] === "GESTIONAR_CITA") {
      const cita = temp[from].citaExistente;
      
      if (["CAMBIAR", "SI", "1"].includes(respuesta)) {
        const servicioExistente = serviciosPorNombre[cita.servicio.toUpperCase()] || serviciosLista[0];
        temp[from] = { 
          servicio: { nombre: cita.servicio, duracion: servicioExistente.duracion },
          empleado: { nombre: cita.empleado },
          cedula: temp[from].cedula,
          nombre: cita.nombre,
          esCambio: true,
          citaOriginal: cita
        };
        estados[from] = "CONFIRMAR_CAMBIO_TIPO";
        await sock.sendMessage(from, { 
          text: `✏️ *Modificar cita*\n\nTu cita actual: ${temp[from].servicio.nombre} con ${temp[from].empleado.nombre}.\n\n¿Qué deseas cambiar?\n\n1️⃣ Solo fecha/hora (mantener servicio y estilista)\n2️⃣ Servicio y/o estilista también\n\nEscribe el número (ej: 1)\n\nEscribe 'MENU' para volver.` 
        });
        return;
      }

      if (["CANCELAR", "2"].includes(respuesta)) {
        try {
          if (cita.eventId) {
            await eliminarEvento(cita.eventId, cita.empleado);
          }

          const clienteRef = db.ref(`clientes/${temp[from].cedula}`);
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
        } catch (error) {
          console.error("Error cancelando cita:", error);
          await sock.sendMessage(from, { 
            text: "❌ Ocurrió un error al cancelar la cita. Por favor, intenta nuevamente o contacta al salón." 
          });
        }
        delete estados[from];
        delete temp[from];
        return;
      }

      if (["NO", "3"].includes(respuesta)) {
        delete estados[from];
        delete temp[from];
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
    if (estados[from] === "CONFIRMAR_CAMBIO_TIPO") {
      if (["1"].includes(respuesta)) {
        estados[from] = "CONFIRMAR_CLIENTE";
        await sock.sendMessage(from, { 
          text: `👌 Mantendremos el servicio (${temp[from].servicio.nombre}) y estilista (${temp[from].empleado.nombre}).\n\nAhora, busquemos una nueva fecha/hora.\n\nEscribe 'SI' para continuar o 'MENU' para volver.` 
        });
        return;
      } else if (["2"].includes(respuesta)) {
        estados[from] = "MENU_SERVICIOS_CAMBIO";
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
    if (estados[from] === "CONSULTAR_NO_ENCONTRADA") {
      if (["SI", "SÍ", "1"].includes(respuesta)) {
        estados[from] = "MENU_SERVICIOS";
        const listaServicios = serviciosLista.map(s => 
          `${s.id}️⃣ ${s.nombre} - ${formatearDuracion(s.duracion)}`
        ).join('\n');
        await sock.sendMessage(from, { 
          text: `💇‍♀️ *Servicios Disponibles*\n\n${listaServicios}\n\nEscribe el número del servicio (ej: 1)\n\nEscribe 'MENU' para volver.` 
        });
        return;
      }

      if (["NO", "2"].includes(respuesta)) {
        delete estados[from];
        delete temp[from];
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
    if (estados[from] === "MENU_SERVICIOS" || estados[from] === "MENU_SERVICIOS_CAMBIO") {
      const servicioSeleccionado = serviciosLista.find(s => s.id === respuesta);
      if (!servicioSeleccionado) {
        await sock.sendMessage(from, { 
          text: "❗ Número de servicio no válido. Por favor escribe un número del 1 al 6.\n\nEscribe 'MENU' para volver." 
        });
        return;
      }

      temp[from] = { 
        ...temp[from],
        servicio: { nombre: servicioSeleccionado.nombre, duracion: servicioSeleccionado.duracion },
        esCambio: estados[from] === "MENU_SERVICIOS_CAMBIO"
      };
      
      estados[from] = "SELECCION_EMPLEADO";
      
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
    if (estados[from] === "SELECCION_EMPLEADO") {
      const empleadoSeleccionado = empleadosLista.find(e => e.id === respuesta);
      if (!empleadoSeleccionado) {
        await sock.sendMessage(from, { 
          text: "❗ Número de estilista no válido. Por favor escribe 1 o 2.\n\nEscribe 'MENU' para volver." 
        });
        return;
      }

      temp[from].empleado = { nombre: empleadoSeleccionado.nombre };
      estados[from] = "INGRESAR_CEDULA";
      
      await sock.sendMessage(from, { 
        text: `✨ *¡Excelente elección!* ${temp[from].empleado.nombre} es uno de nuestros mejores estilistas.\n\n🪪 Ahora, para continuar con tu cita de *${temp[from].servicio.nombre}*, por favor escribe tu número de cédula (solo números, ej: 12345678):\n\nEscribe 'MENU' para volver.` 
      });
      return;
    }

    // ===============================
    // INGRESAR CÉDULA
    // ===============================
    if (estados[from] === "INGRESAR_CEDULA") {
      if (!/^\d{5,}$/.test(originalText)) {
        await sock.sendMessage(from, { 
          text: "❗ Formato inválido. Por favor, escribe solo números de tu cédula (ej: 12345678)\n\nEscribe 'MENU' para volver." 
        });
        return;
      }

      temp[from].cedula = originalText;
      
      const hasPendingDiagnosis = await tieneDiagnosticoPendiente(originalText);
      if (hasPendingDiagnosis) {
        await sock.sendMessage(from, { 
          text: "❌ Lo sentimos, tienes una cita de *Diagnóstico* pendiente. Debes completarla antes de poder agendar otros servicios.\n\nPor favor, consulta tus citas existentes escribiendo '2️⃣' en el menú principal.\n\nEscribe 'MENU' para volver." 
        });
        estados[from] = "INICIO";
        return;
      }
      
      const clienteRef = db.ref(`clientes/${originalText}`);
      const snap = await clienteRef.once('value');
      
      if (!snap.exists()) {
        estados[from] = "CONFIRMAR_ES_NUEVO";
        await sock.sendMessage(from, { 
          text: `👋 Según nuestro registro, no tenemos información de esta cédula.\n\n¿Eres realmente un cliente **nuevo** de *Porque Tú Eres Bella* y nunca has tenido un diagnóstico con nosotros? Escribe 'SI' para confirmar que eres nuevo o 'NO' si ya has sido cliente anteriormente.` 
        });
      } else {
        const clienteData = snap.val();
        temp[from].nombre = clienteData.nombre || "Cliente";

        if (clienteData.requiereDiagnostico === true && temp[from].servicio.nombre !== "Diagnóstico") {
          await sock.sendMessage(from, { 
            text: "⚠️ Según nuestro registro, aún necesitas realizar tu *Diagnóstico* inicial.\n\nEstamos ajustando tu cita a Diagnóstico para poder continuar con los demás servicios." 
          });
          const diag = serviciosLista.find(s => s.id === '6');
          temp[from].servicio = { nombre: diag.nombre, duracion: diag.duracion };
        }

        estados[from] = "INGRESAR_CELULAR";
        await sock.sendMessage(from, { 
          text: `¡Hola ${temp[from].nombre}! 😊\n\n📱 Por favor, escribe tu número de celular (10 dígitos, ej: 3001234567) para confirmar o actualizar:\n\nEscribe 'MENU' para volver.` 
        });
      }
      return;
    }

    // ===============================
    // CONFIRMAR SI ES NUEVO
    // ===============================
    if (estados[from] === "CONFIRMAR_ES_NUEVO") {
      if (["SI", "SÍ"].includes(respuesta)) {
        if (temp[from].servicio.nombre !== "Diagnóstico") {
          await sock.sendMessage(from, { 
            text: "👋 ¡Perfecto! Como eres un cliente nuevo, es **obligatorio** realizar un *Diagnóstico* inicial para evaluar tu cabello y recomendar el mejor servicio.\n\nEstamos ajustando tu cita a Diagnóstico." 
          });
          const diag = serviciosLista.find(s => s.id === '6');
          temp[from].servicio = { nombre: diag.nombre, duracion: diag.duracion };
        }

        estados[from] = "INGRESAR_NOMBRE";
        await sock.sendMessage(from, { 
          text: `👋 ¡Bienvenido/a nuevo cliente!\n\n✍️ Para completar tu registro, escribe tu nombre completo:\n\nEscribe 'MENU' para volver.` 
        });
      } 
      else if (["NO"].includes(respuesta)) {
        estados[from] = "INGRESAR_NOMBRE_EXISTENTE";
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
    if (estados[from] === "INGRESAR_NOMBRE") {
      if (originalText.trim().length < 2) {
        await sock.sendMessage(from, { 
          text: "❗ Por favor, escribe un nombre válido (mínimo 2 caracteres).\n\nEscribe 'MENU' para volver." 
        });
        return;
      }

      temp[from].nombre = originalText.trim();
      estados[from] = "INGRESAR_CELULAR";
      
      await sock.sendMessage(from, { 
        text: `¡Hola ${temp[from].nombre}! 👋\n\n📱 Ahora, para mantenerte al tanto de tu cita, escribe tu número de celular (10 dígitos, ej: 3001234567):\n\nEscribe 'MENU' para volver.` 
      });
      return;
    }

    // ===============================
    // INGRESAR NOMBRE (existente que dijo NO ser nuevo)
    // ===============================
    if (estados[from] === "INGRESAR_NOMBRE_EXISTENTE") {
      if (originalText.trim().length < 2) {
        await sock.sendMessage(from, { 
          text: "❗ Por favor, escribe un nombre válido (mínimo 2 caracteres).\n\nEscribe 'MENU' para volver." 
        });
        return;
      }

      temp[from].nombre = originalText.trim();
      estados[from] = "INGRESAR_CELULAR";
      
      await sock.sendMessage(from, { 
        text: `¡Hola ${temp[from].nombre}! 👋\n\n📱 Ahora, para mantener tu información actualizada, escribe tu número de celular (10 dígitos, ej: 3001234567):\n\nEscribe 'MENU' para volver.` 
      });
      return;
    }

    // ===============================
    // INGRESAR CELULAR
    // ===============================
    if (estados[from] === "INGRESAR_CELULAR") {
      if (!/^\d{10}$/.test(originalText)) {
        await sock.sendMessage(from, { 
          text: "❗ Formato inválido. Por favor, escribe un número de celular válido de 10 dígitos (ej: 3001234567)\n\nEscribe 'MENU' para volver." 
        });
        return;
      }

      temp[from].celular = originalText;

      const clienteRef = db.ref(`clientes/${temp[from].cedula}`);
      const snap = await clienteRef.once('value');

      if (snap.exists()) {
        if (snap.val().celular !== originalText) {
          await clienteRef.update({ celular: originalText });
        }
      } else {
        await clienteRef.set({
          nombre: temp[from].nombre,
          celular: temp[from].celular,
          citas: [],
          requiereDiagnostico: temp[from].servicio.nombre === "Diagnóstico"
        });
      }

      estados[from] = "CONFIRMAR_CLIENTE";
      
      await sock.sendMessage(from, { 
        text: `¡Hola ${temp[from].nombre}! 😊\n\nHemos registrado/actualizado tu información correctamente.\n\n¿Continuamos con la programación de tu cita?\n\n💇‍♀️ *Servicio:* ${temp[from].servicio.nombre}\n👨‍💼 *Estilista:* ${temp[from].empleado.nombre}\n📱 *Celular:* ${temp[from].celular}\n\nEscribe 'SI' para agendar, 'NO' para cambiar o 'MENU' para volver.` 
      });
      return;
    }

    // ===============================
    // CONFIRMAR INFORMACIÓN DEL CLIENTE
    // ===============================
    if (estados[from] === "CONFIRMAR_CLIENTE") {
      if (["NO"].includes(respuesta)) {
        estados[from] = "MENU_SERVICIOS";
        const listaServicios = serviciosLista.map(s => 
          `${s.id}️⃣ ${s.nombre} - ${formatearDuracion(s.duracion)}`
        ).join('\n');
        await sock.sendMessage(from, { 
          text: `💇‍♀️ *Servicios Disponibles*\n\n${listaServicios}\n\nEscribe el número del servicio (ej: 1)\n\nEscribe 'MENU' para volver.` 
        });
        return;
      }

      if (["MENU"].includes(respuesta)) {
        delete estados[from];
        delete temp[from];
        estados[from] = "INICIO";
        await sock.sendMessage(from, { 
          text: `🔙 *Menú principal*\n\n¡Hola de nuevo! 💖\n\nEscribe:\n1️⃣ para agendar cita\n2️⃣ para consultar cita\n3️⃣ para información` 
        });
        return;
      }

      if (["SI", "SÍ"].includes(respuesta)) {
        try {
          await sock.sendMessage(from, { 
            text: `⏳ Buscando horarios disponibles para ${temp[from].servicio.nombre} con ${temp[from].empleado.nombre}...\n\nEsto puede tomar unos segundos.\n\nEscribe 'MENU' para cancelar.` 
          });

          const disponibles = await obtenerHorasDisponibles({
            dias: 7,
            duracionHoras: temp[from].servicio.duracion,
            empleado: temp[from].empleado.nombre
          });

          if (disponibles.length === 0) {
            await sock.sendMessage(from, { 
              text: `😔 Lo sentimos, no hay horarios disponibles para ${temp[from].servicio.nombre} en los próximos 7 días (a partir de mañana).\n\nTe recomendamos:\n• Intentar con otro servicio\n• Consultar en unos días\n• Llamar directamente al salón\n\nEscribe 'MENU' para volver al menú principal.` 
            });
            estados[from] = "INICIO";
            return;
          }

          temp[from].dias = disponibles;
          estados[from] = "SELECCIONAR_DIA";

          const opcionesDias = disponibles.map((d, i) => 
            `${i + 1}️⃣ ${d.fecha} (${d.slots.length} horarios disponibles)`
          ).join('\n');

          await sock.sendMessage(from, { 
            text: `📅 *Días Disponibles*\n\nSelecciona el día para tu cita de ${temp[from].servicio.nombre}:\n\n${opcionesDias}\n\nEscribe el número del día (ej: 1)\n\nEscribe 'MENU' para volver.` 
          });
        } catch (error) {
          console.error("Error obteniendo horarios:", error);
          await sock.sendMessage(from, { 
            text: `❌ Ocurrió un error al buscar horarios disponibles. Por favor intenta nuevamente.\n\nEscribe 'MENU' para volver al menú principal.` 
          });
          estados[from] = "INICIO";
        }
        return;
      }

      await sock.sendMessage(from, { 
        text: "❓ Por favor, escribe 'SI', 'NO' o 'MENU'." 
      });
      return;
    }

    // ===============================
    // SELECCIONAR DÍA
    // ===============================
    if (estados[from] === "SELECCIONAR_DIA") {
      const indice = parseInt(respuesta) - 1;
      
      if (isNaN(indice) || indice < 0 || indice >= temp[from].dias.length) {
        await sock.sendMessage(from, { 
          text: `❗ Número de día no válido. Por favor escribe un número entre 1 y ${temp[from].dias.length}.\n\nEscribe 'MENU' para volver.` 
        });
        return;
      }

      const diaSeleccionado = temp[from].dias[indice];
      temp[from].horas = diaSeleccionado.slots;
      temp[from].diaSeleccionado = diaSeleccionado;
      estados[from] = "SELECCIONAR_HORA";

      const opcionesHoras = diaSeleccionado.slots.map((h, i) => 
        `${i + 1}️⃣ ${h.label}`
      ).join('\n');

      await sock.sendMessage(from, { 
        text: `🕐 *Horarios Disponibles para ${diaSeleccionado.fecha}*\n\nSelecciona la hora para tu cita de ${temp[from].servicio.nombre} con ${temp[from].empleado.nombre}:\n\n${opcionesHoras}\n\nEscribe el número de la hora (ej: 1)\n\nEscribe 'MENU' para volver.` 
      });
      return;
    }

    // ===============================
    // SELECCIONAR HORA → CREAR CITA
    // ===============================
    if (estados[from] === "SELECCIONAR_HORA") {
      const indice = parseInt(respuesta) - 1;
      
      if (isNaN(indice) || indice < 0 || indice >= temp[from].horas.length) {
        await sock.sendMessage(from, { 
          text: `❗ Número de hora no válido. Por favor escribe un número entre 1 y ${temp[from].horas.length}.\n\nEscribe 'MENU' para volver.` 
        });
        return;
      }

      const horaSeleccionada = temp[from].horas[indice];

      try {
        const eventId = await crearEvento({
          nombre: `${temp[from].nombre} (${temp[from].cedula})`,
          servicio: temp[from].servicio.nombre,
          empleado: temp[from].empleado.nombre,
          inicioISO: horaSeleccionada.inicioISO,
          duracionHoras: temp[from].servicio.duracion,
          telefono: temp[from].celular,
          cedula: temp[from].cedula,
          esCambio: temp[from].esCambio ?? false
        });

        const citaData = {
          nombre: temp[from].nombre,
          cedula: temp[from].cedula,
          servicio: temp[from].servicio.nombre,
          empleado: temp[from].empleado.nombre,
          inicio: horaSeleccionada.inicioISO,
          fechaCreacion: new Date().toISOString(),
          estado: "confirmada",
          eventId: eventId,
          recordatorioEnviado: false
        };

        const clienteRef = db.ref(`clientes/${temp[from].cedula}`);
        
        if (temp[from].esCambio && temp[from].citaOriginal?.eventId) {
          try {
            await eliminarEvento(
              temp[from].citaOriginal.eventId,
              temp[from].citaOriginal.empleado
            );
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

          if (temp[from].esCambio && temp[from].citaOriginal?.arrayIndex !== undefined) {
            clienteData.citas = clienteData.citas.filter((_, idx) => 
              idx !== temp[from].citaOriginal.arrayIndex
            );
          }

          clienteData.citas.push(citaData);
          return clienteData;
        });

        if (temp[from].servicio.nombre === "Diagnóstico") {
          await clienteRef.update({ requiereDiagnostico: false });
        }

        const numeroCompleto = `57${temp[from].celular}@s.whatsapp.net`;
        programarRecordatorio(
          sock,
          numeroCompleto,
          citaData,
          { cedula: temp[from].cedula, nombre: temp[from].nombre, celular: temp[from].celular }
        );

        const fechaCompleta = new Date(horaSeleccionada.inicioISO);
        await sock.sendMessage(from, { 
          text: `🎉 *¡Cita ${temp[from].esCambio ? 'modificada' : 'confirmada'} exitosamente!* 🎉\n\n` +
                `👤 *Cliente:* ${temp[from].nombre}\n` +
                `🪪 *Cédula:* ${temp[from].cedula}\n` +
                `💇‍♀️ *Servicio:* ${temp[from].servicio.nombre}\n` +
                `👨‍💼 *Estilista:* ${temp[from].empleado.nombre}\n` +
                `📅 *Fecha:* ${formatearFecha(fechaCompleta)}\n` +
                `🕐 *Hora:* ${horaSeleccionada.label}\n\n` +
                `📲 Recibirás un recordatorio 2 horas antes de tu cita.\n\n` +
                `💖 *¡Te esperamos con mucho cariño en Porque Tú Eres Bella!*\n\n` +
                `Si necesitas cambiar o cancelar tu cita, escribe '2️⃣' en el menú principal para consultar.\n\n` +
                `Escribe 'MENU' para volver al menú principal.` 
        });

        if (temp[from].esCambio) {
          await sock.sendMessage(from, { 
            text: `✏️ *Cita actualizada correctamente.* Tu nueva cita ha reemplazado la anterior.\n\n¡Gracias por tu preferencia! 💖` 
          });
        }

        // ===============================
        // NOTIFICAR AL GRUPO
        // ===============================
        const mensajeGrupo = `🔔 *Nueva cita agendada${temp[from].esCambio ? ' (modificada)' : ''}!*\n\n` +
                             `👤 Cliente: ${temp[from].nombre} (${temp[from].cedula})\n` +
                             `💇‍♀️ Servicio: ${temp[from].servicio.nombre}\n` +
                             `👨‍💼 Estilista: ${temp[from].empleado.nombre}\n` +
                             `📅 Fecha: ${formatearFecha(fechaCompleta)}\n` +
                             `🕐 Hora: ${horaSeleccionada.label}\n\n` +
                             `¡Preparémonos para atender con excelencia! 💖`;

        try {
          await sock.sendMessage(GROUP_ID, { text: mensajeGrupo });
          console.log(`Notificación enviada al grupo: ${GROUP_ID}`);
        } catch (err) {
          console.error("Error enviando notificación al grupo:", err);
        }

        delete estados[from];
        delete temp[from];

      } catch (error) {
        console.error("Error creando/actualizando cita:", error);
        await sock.sendMessage(from, { 
          text: `❌ Ocurrió un error al confirmar tu cita. Por favor intenta nuevamente.\n\nSi el problema persiste, contacta al salón directamente.\n\nEscribe 'MENU' para volver al menú principal.` 
        });
        estados[from] = "INICIO";
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

  });

  console.log("🚀 Bot iniciado - esperando conexión...");
}

async function obtenerBloqueosFuturos() {
  try {
    const snapshot = await db.ref('clientes/-1').once('value');
    if (!snapshot.exists()) return [];

    const data = snapshot.val();
    const citas = data.citas || [];

    return citas
      .filter(c => 
        new Date(c.inicio) > new Date() && 
        c.estado === "bloqueo"  // o c.servicio === "BLOQUEO"
      )
      .map(cita => ({
        ...cita,
        cedula: "-1"
      }))
      .sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
  } catch (err) {
    console.error("Error obteniendo bloqueos:", err);
    return [];
  }
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