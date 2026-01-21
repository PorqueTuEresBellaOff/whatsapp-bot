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
  "Carlos":  "21adc861b9a57704f51296e04d0a23d6110d0aac9274586087282173eef92e23@group.calendar.google.com", // ← TU ID REAL
  "Arturo":  "567580a874aa3a34e317086a7e2367e612723dcf0300991a9dd9169c8deb9b0a@group.calendar.google.com", // ← TU ID REAL
};

function getCalendarId(empleadoNombre) {
  const calendarId = CALENDARS_BY_EMPLEADO[empleadoNombre];
  if (!calendarId) {
    throw new Error(`No se encontró ID de calendario para el empleado: ${empleadoNombre}`);
  }
  return calendarId;
}

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