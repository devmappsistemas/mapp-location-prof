/**
 * Haversine distance calculation between two geographic points.
 * Ported from servidorNode-rotinamapp (LatLonSpherical / FormulaPonto).
 * Reference: www.movable-type.co.uk/scripts/latlong.html
 *
 * @module utils/geo/calcularDistancia
 */

const EARTH_RADIUS_METERS = 6371e3;

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

/**
 * @param {number} lat1 - Latitude do ponto 1 (graus)
 * @param {number} lon1 - Longitude do ponto 1 (graus)
 * @param {number} lat2 - Latitude do ponto 2 (graus)
 * @param {number} lon2 - Longitude do ponto 2 (graus)
 * @returns {number} Distância em metros
 */
export function calcularDistanciaMetros(lat1, lon1, lat2, lon2) {
  const φ1 = toRadians(Number(lat1));
  const φ2 = toRadians(Number(lat2));
  const Δφ = toRadians(Number(lat2) - Number(lat1));
  const Δλ = toRadians(Number(lon2) - Number(lon1));

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}
