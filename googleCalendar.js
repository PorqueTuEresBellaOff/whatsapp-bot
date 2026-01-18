import { google } from "googleapis";
import path from "path";

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
 * Crea un evento de bloqueo en la agenda
 * @param {string} empleado - "CARLOS", "ARTURO" o "AMBOS"
 * @param {string} fechaStr - formato YYYY-MM-DD
 * @param {string} tipo - "todo" o rango "HH:MM HH:MM"
 * @returns {Promise<string>} ID del evento creado (el primero si es AMBOS)
 */
export async function crearBloqueoAgenda(empleado, fechaStr, tipo = "todo") {
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
    summary: "🔒 BLOQUEO AGENDA - NO AGENDAR",
    description: "Bloqueo administrativo - NO DISPONIBLE para citas\nMotivo: " + (tipo === "todo" ? "Todo el día bloqueado" : `Horario bloqueado`),
    colorId: "4", // Rojo suave (puedes cambiar el colorId según tu preferencia)
    reminders: { useDefault: false },
  };

  let startDateTime, endDateTime;

  if (tipo.toLowerCase() === "todo") {
    // Bloqueo del horario laboral: 8:00 a 18:00 (6 pm)
    const inicioStr = "08:00:00";
    const finStr    = "18:00:00";

    startDateTime = {
      dateTime: `${fechaStr}T${inicioStr}`,
      timeZone: "America/Bogota"
    };

    endDateTime = {
      dateTime: `${fechaStr}T${finStr}`,
      timeZone: "America/Bogota"
    };
  } else {
    // Rango horario específico
    const [inicioStr, finStr] = tipo.split(" ");
    if (!inicioStr || !finStr) {
      throw new Error("Formato de horario inválido. Usa: HH:MM HH:MM");
    }

    const [inicioH, inicioM] = inicioStr.split(":").map(Number);
    const [finH, finM] = finStr.split(":").map(Number);

    startDateTime = {
      dateTime: `${fechaStr}T${inicioH.toString().padStart(2,'0')}:${inicioM.toString().padStart(2,'0')}:00`,
      timeZone: "America/Bogota"
    };

    endDateTime = {
      dateTime: `${fechaStr}T${finH.toString().padStart(2,'0')}:${finM.toString().padStart(2,'0')}:00`,
      timeZone: "America/Bogota"
    };
  }

  const idsCreados = [];

  for (const emp of empleados) {
    const calendarId = getCalendarId(emp);

    const evento = {
      ...eventoBase,
      start: startDateTime,
      end: endDateTime,
    };

    try {
      const res = await calendar.events.insert({
        calendarId,
        resource: evento,
        sendUpdates: "none" // No enviar notificaciones a nadie
      });

      console.log(`Bloqueo creado para ${emp} → Event ID: ${res.data.id}`);
      idsCreados.push(res.data.id);
    } catch (err) {
      console.error(`Error creando bloqueo para ${emp}:`, err);
      throw err;
    }
  }

  // Retornamos el primer ID creado (o el único si no es AMBOS)
  return idsCreados[0];
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