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

import { crearEvento, eliminarEvento } from "./googleCalendar.js";
import { obtenerHorasDisponibles } from "./disponibilidad.js";

// ===============================
// CONFIGURACIÓN DEL GRUPO PARA NOTIFICACIONES Y MODO ADMIN
// ===============================
const GROUP_ID = '120363424425387340@g.us'; // ← CAMBIAR AQUÍ: Reemplaza con el ID real de tu grupo

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

export const db = admin.database();

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

  const dosHorasAntes = new Date(fechaCita.getTime() - 2 * 60 * 60 * 1000);
  const faltanMenosDe2Horas = ahora >= dosHorasAntes;

  const delay = faltanMenosDe2Horas 
    ? 30000
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

      const mensajeGrupo = `🔔 *RECORDATORIO 2 HORAS* - Cita próxima\n\n` +
                          `👤 ${clienteData.nombre || 'Cliente'} (${clienteData.cedula})\n` +
                          `📱 ${clienteData.celular ? '57' + clienteData.celular : 'No registrado'}\n` +
                          `💇‍♀️ ${cita.servicio}\n` +
                          `👨‍💼 ${cita.empleado}\n` +
                          `📅 ${formatearFecha(fechaCita)}\n` +
                          `🕐 ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit', hour12: true })}\n\n` +
                          `¡Preparar estación y recibir al cliente! ✨`;

      await sock.sendMessage(GROUP_ID, { text: mensajeGrupo });

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

        if (cita.estado === "bloqueo") {
          // Opcional: Si quieres limpiar bloques pasados, quita este 'continue' y deja que elimine
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
        if (cita.estado !== "confirmada") return;  // Skip bloqueos
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
          if (new Date(cita.inicio) > new Date() && (cita.estado === "confirmada" || cita.estado === "bloqueo")) {
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

    // ===============================
    // COMANDOS ADMIN (solo en el grupo)
    // ===============================
    if (esGrupoAdmin) {
      if (respuesta === "#HELP" || respuesta === "#AYUDA") {
        const textoHelp =
          "🆘 *AYUDA – COMANDOS DE ADMINISTRADOR*\n\n" +

          "📅 *#CITAS*\n" +
          "Muestra la lista de todas las citas futuras, ordenadas por fecha.\n" +
          "Cada cita tiene un número que se usa para cancelarla.\n\n" +

          "❌ *#CANCELAR NÚMERO*\n" +
          "Cancela una cita usando el número que aparece en *#citas*.\n" +
          "Ejemplo:\n" +
          "#cancelar 3\n\n" +

          "⛔ *#BLOQUEAR EMPLEADO FECHA HORARIO*\n" +
          "Bloquea la agenda de un empleado.\n\n" +
          "• Empleado: CARLOS, ARTURO o AMBOS\n" +
          "• Fecha: YYYY-MM-DD\n" +
          "• Horario:\n" +
          "   - `todo` → bloquea todo el día\n" +
          "   - `HH:MM HH:MM` → bloquea un rango de horas\n\n" +
          "Ejemplos:\n" +
          "#bloquear CARLOS 2025-03-15 todo\n" +
          "#bloquear AMBOS 2025-04-02 09:00 14:00\n\n" +

          "ℹ️ Escribe los comandos exactamente como se muestran.\n" +
          "💖 Porque Tú Eres Bella";

        await sock.sendMessage(from, { text: textoHelp });
        return;
      }

      if (respuesta === "#CITAS" || respuesta === "#CITA") {
        const citas = await obtenerTodasCitasFuturas();

        if (citas.length === 0) {
          await sock.sendMessage(from, { text: "📅 No hay citas futuras registradas en este momento." });
          return;
        }

        let texto = "📅 *CITAS PRÓXIMAS* (ordenadas por fecha)\n\n";
        citas.forEach((cita, index) => {
          const fecha = new Date(cita.inicio);
          if (cita.cedula === "-1" && cita.estado === "bloqueo") {
            texto += `${index + 1}. BLOQUEO ADMINISTRATIVO (${cita.empleado})\n`;
            texto += `   Motivo: ${cita.motivo || "No especificado"}\n`;
          } else {
            texto += `${index + 1}. ${cita.nombre} (${cita.cedula})\n`;
            texto += `   Servicio: ${cita.servicio}\n`;
          }
          texto += `   Estilista: ${cita.empleado}\n`;
          texto += `   Fecha: ${formatearFecha(fecha)}\n`;
          texto += `   Hora: ${fecha.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit' })}\n`;
          texto += `   Cel: ${cita.celular ? '57' + cita.celular : 'No registrado'}\n\n`;
        });

        await sock.sendMessage(from, { text: texto });
        return;
      }

      if (respuesta.startsWith("#BLOQUEAR ")) {
        const partes = respuesta.split(" ").slice(1);
        if (partes.length < 3) {
          await sock.sendMessage(from, { 
            text: "Formato:\n#bloquear CARLOS|ARTURO|AMBOS YYYY-MM-DD HH:MM HH:MM [motivo opcional...]\n" +
                  "   o\n#bloquear CARLOS|ARTURO|AMBOS YYYY-MM-DD todo [motivo opcional...]\n\n" +
                  "Ejemplos:\n" +
                  "#bloquear CARLOS 2025-03-20 09:00 18:00 Capacitación todo el día\n" +
                  "#bloquear AMBOS 2025-04-02 todo Reunión de equipo\n" +
                  "#bloquear ARTURO 2025-04-15 13:00 20:30"
          });
          return;
        }

        const quien = partes[0].toUpperCase();
        const fechaStr = partes[1];
        let horaInicio, horaFin, motivo;

        if (partes[2].toLowerCase() === "todo") {
          horaInicio = "07:00";
          horaFin    = "22:00";
          motivo = partes.slice(3).join(" ") || "Bloqueo administrativo (día completo)";
        } else {
          if (partes.length < 4) {
            await sock.sendMessage(from, { text: "Cuando no uses 'todo', debes indicar hora inicio y hora fin (HH:MM HH:MM)" });
            return;
          }
          horaInicio = partes[2];
          horaFin    = partes[3];
          motivo = partes.slice(4).join(" ") || "Bloqueo administrativo";
        }

        if (!["CARLOS", "ARTURO", "AMBOS"].includes(quien)) {
          await sock.sendMessage(from, { text: "Empleado debe ser CARLOS, ARTURO o AMBOS" });
          return;
        }

        if (!/^\d{2}:\d{2}$/.test(horaInicio) || !/^\d{2}:\d{2}$/.test(horaFin)) {
          await sock.sendMessage(from, { text: "Formato de hora inválido. Usa HH:MM" });
          return;
        }

        // ───────────────────────────────────────────────────────────────
        // NUEVA FORMA DE CREAR LA FECHA - AJUSTE PARA COLOMBIA (UTC-5)
        // ───────────────────────────────────────────────────────────────
        const [year, month, day] = fechaStr.split('-').map(Number);
        const [hInicio, mInicio] = horaInicio.split(':').map(Number);
        const [hFin, mFin] = horaFin.split(':').map(Number);

        // Creamos la fecha en UTC pero la ajustamos restando 5 horas (porque el servidor está en UTC)
        const inicioUTC = new Date(Date.UTC(year, month - 1, day, hInicio, mInicio, 0, 0));
        inicioUTC.setUTCHours(inicioUTC.getUTCHours() - 5);   // ← AJUSTE COLOMBIA

        const finUTC = new Date(Date.UTC(year, month - 1, day, hFin, mFin, 0, 0));
        finUTC.setUTCHours(finUTC.getUTCHours() + 5);         // ← AJUSTE COLOMBIA

        const duracionHoras = (finUTC - inicioUTC) / (1000 * 60 * 60);

        if (duracionHoras <= 0) {
          await sock.sendMessage(from, { text: "La hora final debe ser mayor a la hora inicial." });
          return;
        }

        const inicioISO = inicioUTC.toISOString();

        console.log(`[BLOQUEO] fechaStr=${fechaStr} | ${horaInicio} → ${inicioISO} | duración=${duracionHoras}h`);

        const empleados = quien === "AMBOS" ? ["Carlos", "Arturo"] : [quien.charAt(0).toUpperCase() + quien.slice(1).toLowerCase()];

        const idsCreados = [];

        for (const emp of empleados) {
          try {
            const eventId = await crearEvento({
              nombre: "BLOQUEO ADMINISTRATIVO",
              servicio: "Bloqueo de agenda",
              empleado: emp,
              inicioISO: inicioISO,
              duracionHoras: duracionHoras,
              telefono: "—",
              cedula: "0",
              descripcionExtra: `Motivo: ${motivo}\nCreado por: Admin vía WhatsApp`
            });

            idsCreados.push(eventId);

            const citaData = {
              nombre: "BLOQUEO ADMINISTRATIVO",
              cedula: "0",
              servicio: "Bloqueo de agenda",
              empleado: emp,
              inicio: inicioISO,
              fechaCreacion: new Date().toISOString(),
              estado: "bloqueo",
              eventId: eventId, 
              motivo: motivo
            };

            // Mejor usar transaction para mantener consistencia con citas normales
            const bloqueosRef = db.ref('clientes/0');
            await bloqueosRef.transaction(current => {
              current = current || {};
              current.citas = current.citas || [];
              current.citas.push(citaData);
              return current;
            });

            console.log(`Bloqueo creado → ${emp} → ${eventId}`);
          } catch (err) {
            console.error(`Error creando bloqueo para ${emp}:`, err);
          }
        }

      if (idsCreados.length === 0) {
        await sock.sendMessage(from, { text: "❌ No se pudo crear ningún bloqueo. Revisa los logs." });
        return;
      }

      const tipoBloqueo = (horaInicio === "07:00" && horaFin === "22:00") 
        ? "día completo (7:00 – 22:00)" 
        : `horario ${horaInicio} – ${horaFin}`;

      await sock.sendMessage(from, { 
        text: `✅ **Bloqueo administrativo creado**!\n\n` +
              `• Empleado(s): ${empleados.join(" y ")}\n` +
              `• Fecha: ${fechaStr}\n` +
              `• Horario: ${tipoBloqueo}\n` +
              `• Motivo: ${motivo}\n` +
              `• Evento(s) creado(s): ${idsCreados.join(", ")}\n\n` +
              `Aparecerá en #citas como BLOQUEO ADMINISTRATIVO y puedes cancelarlo con #cancelar N`
      });

      return;
    }

      if (respuesta.startsWith("#CANCELAR ")) {
        const numStr = respuesta.split(" ")[1];
        const indice = parseInt(numStr) - 1;

        if (isNaN(indice) || indice < 0) {
          await sock.sendMessage(from, { text: "Formato: #cancelar NÚMERO\nEjemplo: #cancelar 4" });
          return;
        }

        const citas = await obtenerTodasCitasFuturas();

        if (indice >= citas.length) {
          await sock.sendMessage(from, { text: `Solo hay ${citas.length} registros. Usa #citas para ver.` });
          return;
        }

        const cita = citas[indice];

        try {
          // Eliminar evento de Google Calendar (solo uno, ya que ahora son individuales)
          if (cita.eventId) {
            await eliminarEvento(cita.eventId, cita.empleado);
          }

          // Eliminar de Firebase
          const clienteRef = db.ref(`clientes/${cita.cedula}`);
          await clienteRef.transaction(current => {
            if (!current?.citas) return current;
            current.citas = current.citas.filter(c => 
              !(c.inicio === cita.inicio && c.empleado === cita.empleado)
            );
            return current;
          });

          if (cita.servicio === "Diagnóstico" && cita.cedula !== "-1") {
            await clienteRef.update({ requiereDiagnostico: true });
          }

          // Mensaje diferente si es bloqueo
          if (cita.cedula === "-1") {
            await sock.sendMessage(from, { 
              text: `🟢 **Bloqueo cancelado exitosamente**\n\n` +
                    `Fecha: ${formatearFecha(new Date(cita.inicio))}\n` +
                    `Empleado: ${cita.empleado}\n` +
                    `Motivo original: ${cita.motivo || "—"}` 
            });

            await sock.sendMessage(GROUP_ID, { 
              text: `🔓 *BLOQUEO CANCELADO*\n\n` +
                    `Fecha: ${formatearFecha(new Date(cita.inicio))}\n` +
                    `Empleado: ${cita.empleado}\n` +
                    `Motivo: ${cita.motivo || "No especificado"}\n` +
                    `Espacio liberado en agenda.` 
            });
          } else {
            // Notificación al cliente
            if (cita.celular) {
              const numeroCliente = `57${cita.celular}@s.whatsapp.net`;
              const fechaCita = new Date(cita.inicio);
              await sock.sendMessage(numeroCliente, { 
                text: `❌ *Tu cita ha sido CANCELADA por el salón*\n\n` +
                      `Cliente: ${cita.nombre}\n` +
                      `Cédula: ${cita.cedula}\n` +
                      `Servicio: ${cita.servicio}\n` +
                      `Estilista: ${cita.empleado}\n` +
                      `Fecha: ${formatearFecha(fechaCita)}\n` +
                      `Hora: ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit' })}\n\n` +
                      `Lamentamos el inconveniente. Puedes agendar una nueva cita respondiendo con 1.\n` +
                      `💖 Porque Tú Eres Bella` 
              });
            }

            // Notificación al grupo - CANCELACIÓN POR ADMIN
            const fechaCitaAdmin = new Date(cita.inicio);
            const mensajeCancelAdmin = 
              `❌ *CITA CANCELADA DESDE ADMINISTRACIÓN*\n\n` +
              `👤 Cliente: ${cita.nombre} (${cita.cedula})\n` +
              `💇‍♀️ Servicio: ${cita.servicio}\n` +
              `👨‍💼 Estilista: ${cita.empleado}\n` +
              `📅 Fecha: ${formatearFecha(fechaCitaAdmin)}\n` +
              `🕐 Hora: ${fechaCitaAdmin.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit' })}\n\n` +
              `Motivo: Cancelación administrativa\n` +
              `Espacio liberado en agenda.`;

            await sock.sendMessage(GROUP_ID, { text: mensajeCancelAdmin })
              .catch(err => console.error("Error notificando cancelación admin al grupo:", err));

            await sock.sendMessage(from, { 
              text: `✅ Cita #${indice+1} CANCELADA exitosamente.\n` +
                    `Cliente: ${cita.nombre} (${cita.cedula})\n` +
                    `Servicio: ${cita.servicio} con ${cita.empleado}\n` +
                    `Se notificó al cliente.` 
            });
          }

        } catch (err) {
          console.error("Error cancelando cita/bloqueo desde admin:", err);
          await sock.sendMessage(from, { text: "❌ Error al cancelar. Revisa los logs." });
        }

        return;
      }
    }

    // ===============================
    // INICIO - MENSAJE DE BIENVENIDA
    // ===============================
    if (!estados[from]) {
      estados[from] = "INICIO";
      await sock.sendMessage(from, { 
        text: `¡Hola! 💖 Bienvenido/a a *Porque Tú Eres Bella* ✨\n\nSomos tu salón de belleza favorito. ¿En qué podemos ayudarte hoy?\n\n*Opciones disponibles:*\n1️⃣ Agendar cita\n2️⃣ Consultar cita existente\n3️⃣ Información de servicios\n\nEscribe el número de la opción (ej: 1)` 
      });
      return;
    }

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

          // Notificación al GRUPO - CANCELACIÓN POR CLIENTE
          const fechaCita = new Date(cita.inicio);
          const mensajeCancelacionGrupo = 
            `❌ *CITA CANCELADA POR EL CLIENTE*\n\n` +
            `👤 Cliente: ${cita.nombre || "Sin nombre"} (${temp[from].cedula})\n` +
            `💇‍♀️ Servicio: ${cita.servicio}\n` +
            `👨‍💼 Estilista: ${cita.empleado}\n` +
            `📅 Fecha: ${formatearFecha(fechaCita)}\n` +
            `🕐 Hora: ${fechaCita.toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit' })}\n\n` +
            `Espacio liberado en agenda.`;

          await sock.sendMessage(GROUP_ID, { text: mensajeCancelacionGrupo })
            .catch(err => console.error("No se pudo notificar cancelación al grupo:", err));

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

    if (estados[from] === "SELECCIONAR_HORA") {
      const indice = parseInt(respuesta) - 1;
      
      if (isNaN(indice) || indice < 0 || indice >= temp[from].horas.length) {
        await sock.sendMessage(from, { 
          text: `❗ Número de hora no válido. Por favor escribe un número entre 1 y ${temp[from].horas.length}.\n\nEscribe 'MENU' para volver.` 
        });
        return;
      }

      const horaSeleccionada = temp[from].horas[indice];
      const COLOMBIA_OFFSET_HOURS = 5;

      const inicioOriginal = new Date(horaSeleccionada.inicioISO);
      inicioOriginal.setUTCHours(inicioOriginal.getUTCHours() + COLOMBIA_OFFSET_HOURS);
      const inicioISO_Ajustado = inicioOriginal.toISOString();

      try {
        const eventId = await crearEvento({
          nombre: `${temp[from].nombre} (${temp[from].cedula})`,
          servicio: temp[from].servicio.nombre,
          empleado: temp[from].empleado.nombre,
          inicioISO: inicioISO_Ajustado,
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

        // Mensaje al cliente
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

        // Notificación al grupo - NUEVA o MODIFICADA
        const esModificacion = temp[from].esCambio === true;

        const mensajeGrupo = 
          `${esModificacion ? '✏️' : '🔔'} *${esModificacion ? 'CITA MODIFICADA' : 'NUEVA CITA AGENDADA'}*\n\n` +
          `👤 Cliente: ${temp[from].nombre} (${temp[from].cedula})\n` +
          `💇‍♀️ Servicio: ${temp[from].servicio.nombre}\n` +
          `👨‍💼 Estilista: ${temp[from].empleado.nombre}\n` +
          `📅 Fecha: ${formatearFecha(fechaCompleta)}\n` +
          `🕐 Hora: ${horaSeleccionada.label}\n` +
          (esModificacion ? `🔄 *Modificación de cita anterior*\n` : ``) +
          `\n¡${esModificacion ? 'Actualizar preparación' : 'Preparémonos'} para atender con excelencia! 💖`;

        try {
          await sock.sendMessage(GROUP_ID, { text: mensajeGrupo });
          console.log(`Notificación ${esModificacion ? 'modificación' : 'nueva cita'} enviada al grupo`);
        } catch (err) {
          console.error("Error enviando notificación al grupo:", err);
        }

        if (esModificacion) {
          await sock.sendMessage(from, { 
            text: `✏️ *Cita actualizada correctamente.* Tu nueva cita ha reemplazado la anterior.\n\n¡Gracias por tu preferencia! 💖` 
          });
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

    await sock.sendMessage(from, { 
      text: `❓ No entendí tu mensaje "${originalText}".\n\nPor favor:\n` +
            `• Responde según las instrucciones del mensaje anterior\n` +
            `• O escribe 'MENU' para volver al menú principal\n` +
            `• O escribe 'AYUDA' para más información` 
    });

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

function calcularDuracionHoras(horaInicio, horaFin) {
  const [h1, m1] = horaInicio.split(":").map(Number);
  const [h2, m2] = horaFin.split(":").map(Number);
  
  const minTotal1 = h1 * 60 + m1;
  const minTotal2 = h2 * 60 + m2;
  
  if (minTotal2 <= minTotal1) return null;
  
  return (minTotal2 - minTotal1) / 60;
}