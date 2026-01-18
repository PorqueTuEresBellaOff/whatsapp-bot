import { google } from "googleapis";
import path from "path";
import { db } from "./index.js";

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.CALENDAR_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({
  version: "v3",
  auth,
});

// ¡Calendarios separados por empleado!
const CALENDARS_BY_EMPLEADO = {
  "Carlos":  "57a7566fe4630dcdec998aba92b2e604bd75ae4a90cfbaad79cf3bb82d2fcacf@group.calendar.google.com", // ← TU ID REAL
  "Arturo":  "25bdad0375a183e752e99b772c8a9fd9d85f326818bfcd15483fe92b0a95cfd3@group.calendar.google.com", // ← TU ID REAL
};

function getCalendarId(empleadoNombre) {
  const calendarId = CALENDARS_BY_EMPLEADO[empleadoNombre];
  if (!calendarId) {
    throw new Error(`No se encontró ID de calendario para el empleado: ${empleadoNombre}`);
  }
  return calendarId;
}

/**
 * @param {string} empleado - "CARLOS", "ARTURO" o "AMBOS"
 * @param {string} fechaStr - YYYY-MM-DD
 * @param {string} tipo - "todo" o "09:00 14:00"
 * @param {Object} adminInfo - { motivo?: string, creadoPor?: string }
 * @returns {Promise<string>} ID del evento principal creado
 */
export async function crearBloqueoAgenda(empleado, fechaStr, tipo = "todo", adminInfo = {}) {
  const fecha = new Date(fechaStr);
  if (isNaN(fecha.getTime())) {
    throw new Error("Fecha inválida. Usa formato YYYY-MM-DD");
  }

  const empleados = [];
  if (empleado.toUpperCase() === "AMBOS") {
    empleados.push("Carlos", "Arturo");
  } else {
    empleados.push(empleado.charAt(0).toUpperCase() + empleado.slice(1).toLowerCase());
  }

  const eventoBase = {
    summary: "🔒 BLOQUEO - NO AGENDAR",
    description: `Bloqueo administrativo\nMotivo: ${adminInfo.motivo || (tipo === "todo" ? "Todo el día" : "Horario específico")}\nCreado por: ${adminInfo.creadoPor || "Admin"}`,
    colorId: "4", // rojo suave
    reminders: { useDefault: false },
  };

  let startDateTime, endDateTime;

  if (tipo.toLowerCase() === "todo") {
    startDateTime = { dateTime: `${fechaStr}T08:00:00`, timeZone: "America/Bogota" };
    endDateTime   = { dateTime: `${fechaStr}T18:00:00`, timeZone: "America/Bogota" };
  } else {
    const [ini, fin] = tipo.split(" ");
    if (!ini || !fin) throw new Error("Formato horario inválido");
    startDateTime = { dateTime: `${fechaStr}T${ini}:00`, timeZone: "America/Bogota" };
    endDateTime   = { dateTime: `${fechaStr}T${fin}:00`, timeZone: "America/Bogota" };
  }

  const idsCreados = [];

  for (const emp of empleados) {
    const calendarId = getCalendarId(emp);
    const evento = { ...eventoBase, start: startDateTime, end: endDateTime };

    const res = await calendar.events.insert({
      calendarId,
      resource: evento,
      sendUpdates: "none"
    });

    idsCreados.push(res.data.id);
    console.log(`Bloqueo GC creado → ${emp} → ${res.data.id}`);
  }

  // ──────────────────────────────────────────────
  // Guardar como "cita" en Firebase bajo cliente -1
  // ──────────────────────────────────────────────
  const db = admin.database();
  const bloqueoData = {
    nombre: "BLOQUEO ADMINISTRATIVO",
    cedula: "-1",
    servicio: "Bloqueo de agenda",
    empleado: empleados.length === 1 ? empleados[0] : "AMBOS",
    inicio: startDateTime.dateTime,
    fechaCreacion: new Date().toISOString(),
    estado: "bloqueo",
    eventId: idsCreados[0],           // guardamos el primero (para compatibilidad con cancelar)
    eventIds: idsCreados,             // si es AMBOS → todos los ids
    motivo: adminInfo.motivo || (tipo === "todo" ? "Día completo bloqueado" : `Rango ${tipo}`),
    tipoBloqueo: tipo,
  };

  await db.ref('clientes/-1/citas').push(bloqueoData);
  console.log(`Bloqueo guardado en Firebase bajo clientes/-1`);

  return idsCreados[0]; // retornamos el principal para mantener compatibilidad
}

// ──────────────────────────────────────────────
// Funciones existentes (sin cambios)
// ──────────────────────────────────────────────

export async function crearEvento({
  nombre,
  servicio,
  empleado,
  inicioISO,
  duracionHoras,
  telefono,
  cedula,
  esCambio = false
}) {
  console.log("DEBUG crearEvento → inicioISO:", inicioISO);
  console.log("DEBUG crearEvento → duracionHoras:", duracionHoras);
  console.log("DEBUG crearEvento → esCambio:", esCambio);
  console.log("DEBUG crearEvento → empleado:", empleado);

  const calendarId = getCalendarId(empleado);

  const inicio = new Date(inicioISO);
  if (isNaN(inicio.getTime())) {
    throw new Error("Fecha inicio inválida: " + inicioISO);
  }

  // Margen de 15 minutos
  const fin = new Date(inicio.getTime() + (duracionHoras + 0.25) * 60 * 60 * 1000);

  const evento = {
    summary: `Cita - ${servicio}`,
    description: `Cliente: ${nombre} (${cedula})\nTeléfono: ${telefono}\nEmpleado: ${empleado}\nServicio: ${servicio}`,
    start: { dateTime: inicio.toISOString(), timeZone: "America/Bogota" },
    end:   { dateTime: fin.toISOString(),    timeZone: "America/Bogota" },
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: 120 }],
    }
  };

  try {
    const res = await calendar.events.insert({
      calendarId,
      resource: evento,
      sendUpdates: "all"
    });

    console.log("Evento creado → ID:", res.data.id);
    return res.data.id;
  } catch (err) {
    console.error("Error creando evento:", err);
    throw err;
  }
}

export async function eliminarEvento(eventId, empleado) {
  if (!eventId) return;

  const calendarId = getCalendarId(empleado);

  try {
    await calendar.events.delete({ calendarId, eventId });
    console.log(`Evento eliminado: ${eventId}`);
  } catch (error) {
    if (error.response?.status === 410) {
      console.log(`Evento ${eventId} ya no existe (410 Gone)`);
    } else {
      console.error(`Error eliminando ${eventId}:`, error);
    }
  }
}

export async function obtenerBusy(timeMin, timeMax, empleado) {
  const calendarId = getCalendarId(empleado);

  try {
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: "America/Bogota",
        items: [{ id: calendarId }]
      }
    });

    return res.data.calendars[calendarId]?.busy || [];
  } catch (err) {
    console.error(`Error free/busy ${empleado}:`, err);
    return [];
  }
}