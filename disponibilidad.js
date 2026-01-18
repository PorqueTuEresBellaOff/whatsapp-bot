import { obtenerBusy } from "./googleCalendar.js";

function seCruza(aInicio, aFin, bInicio, bFin) {
  return aInicio < bFin && aFin > bInicio;
}

export async function obtenerHorasDisponibles({
  dias = 7,
  horaInicio = 8,
  horaFin = 18,
  duracionHoras = 2,
  empleado                      // ← parámetro obligatorio ahora
}) {
  if (!empleado) {
    throw new Error("El parámetro 'empleado' es obligatorio en obtenerHorasDisponibles");
  }

  const ahora = new Date();
  const finRango = new Date();
  finRango.setDate(finRango.getDate() + dias + 1);

  const busy = await obtenerBusy(
    ahora.toISOString(),
    finRango.toISOString(),
    empleado
  );

  const disponibles = [];

  for (let d = 1; d <= dias; d++) {
    const fecha = new Date();
    fecha.setDate(fecha.getDate() + d);

    if (fecha.getDay() === 0) continue; // domingo no

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
        slots
      });
    }
  }

  return disponibles;
}