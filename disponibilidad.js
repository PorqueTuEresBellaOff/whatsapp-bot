// disponibilidad.js (versión modificada)
// Cambios principales:
// 1. En obtenerHorasDisponibles: 
//    - Acepta nuevo parámetro opcional 'startDate' (Date) para comenzar desde una fecha específica.
//    - En el loop, usa 'd = 0' si startDate es proporcionado (incluye el startDate si es futuro).
//    - Agrega 'fechaISO' en cada disponible para parseo seguro.
//    - Filtra días pasados: si la fecha es anterior a hoy, skip.
// 2. No se cambia estaHoraDisponibleAhora, ya que no afecta.

import { obtenerBusy } from "./googleCalendar.js";

function seCruza(aInicio, aFin, bInicio, bFin) {
  return aInicio < bFin && aFin > bInicio;
}

export async function obtenerHorasDisponibles({
  startDate = null,
  dias = 7,
  horaInicio = 8,
  horaFin = 18,
  duracionHoras = 2,
  empleado
}) {
  if (!empleado) {
    throw new Error("El parámetro 'empleado' es obligatorio en obtenerHorasDisponibles");
  }

  const ahora = new Date();
  const hoyInicio = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 0, 0, 0);
  const hoyStr = hoyInicio.toDateString();

  // Nunca permitir startDate en el pasado o hoy
  let inicioRango = startDate ? new Date(startDate) : new Date(ahora);
  if (!startDate || inicioRango <= hoyInicio) {
    inicioRango = new Date(hoyInicio);
    inicioRango.setDate(inicioRango.getDate() + 1); // empezamos desde mañana
  }

  const finRango = new Date(inicioRango);
  finRango.setDate(finRango.getDate() + dias);

  const busy = await obtenerBusy(
    inicioRango.toISOString(),
    finRango.toISOString(),
    empleado
  );

  const disponibles = [];

  for (let d = 0; d < dias; d++) {
    const fecha = new Date(inicioRango);
    fecha.setDate(fecha.getDate() + d);

    // Exclusión estricta
    if (fecha < hoyInicio) continue;
    if (fecha.toDateString() === hoyStr) continue;
    if (fecha.getDay() === 0) continue; // domingos

    const slots = [];
    for (let h = horaInicio; h + duracionHoras <= horaFin; h++) {
      const inicio = new Date(fecha);
      inicio.setHours(h, 0, 0, 0);

      const fin = new Date(
        inicio.getTime() + duracionHoras * 60 * 60 * 1000
      );

      const ocupado = busy.some(b =>
        seCruza(
          inicio,
          fin,
          new Date(b.start),
          new Date(b.end)
        )
      );

      if (!ocupado) {
        const formato = (d) =>
          d.toLocaleTimeString("es-CO", {
            hour: "numeric",
            minute: "2-digit"
          });
        slots.push({
          inicioISO: inicio.toISOString(),
          label: `${formato(inicio)} - ${formato(fin)}`
        });
      }
    }

    if (slots.length) {
      disponibles.push({
        fecha: fecha.toLocaleDateString("es-CO", {
          weekday: "long",
          day: "numeric",
          month: "long"
        }),
        fechaISO: fecha.toISOString().split('T')[0],
        slots
      });
    }
  }

  return disponibles;
}

/**
 * Verifica SI UN SLOT CONCRETO sigue disponible en este momento exacto
 * (consulta freebusy solo para el intervalo de esa cita)
 *
 * @param {Object} params
 * @param {string} params.empleado
 * @param {string} params.inicioISO formato ISO
 * @param {number} params.duracionHoras
 * @returns {Promise<boolean>} true = disponible, false = ocupado o error
 */
export async function estaHoraDisponibleAhora({ empleado, inicioISO, duracionHoras }) {
  if (!empleado || !inicioISO || typeof duracionHoras !== 'number') {
    console.warn("estaHoraDisponibleAhora → parámetros incompletos", { empleado, inicioISO, duracionHoras });
    return false;
  }

  try {
    const inicio = new Date(inicioISO);
    if (isNaN(inicio.getTime())) {
      console.warn("estaHoraDisponibleAhora → fecha inválida:", inicioISO);
      return false;
    }

    const fin = new Date(inicio.getTime() + duracionHoras * 60 * 60 * 1000);

    // Consulta freebusy SOLO para este rango exacto
    const busyIntervals = await obtenerBusy(
      inicio.toISOString(),
      fin.toISOString(),
      empleado
    );

    // Si hay cualquier cruce → ocupado
    const ocupado = busyIntervals.some(b =>
      seCruza(
        inicio,
        fin,
        new Date(b.start),
        new Date(b.end)
      )
    );

    return !ocupado;

  } catch (err) {
    console.error("Error verificando disponibilidad puntual:", err);
    // Política conservadora: error → tratamos como NO disponible
    return false;
  }
}