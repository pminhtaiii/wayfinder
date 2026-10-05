/**
 * Helper to complement partial/stored offer payloads with required metadata
 * (e.g. ID, total amount/currency, valid segments, and passenger records)
 * for normalization in handoff and booking readiness flows.
 */
export function complementStoredOfferPayload(
  rawOffer: unknown,
  flightOffer?: {
    supplierOfferId?: string | null;
    price?: unknown;
    currency?: string | null;
    departureDate?: Date | string | null;
    adults?: number | null;
    children?: number | null;
    infants?: number | null;
  } | null,
): unknown {
  if (!rawOffer || typeof rawOffer !== 'object' || Array.isArray(rawOffer) || !flightOffer) {
    return rawOffer;
  }
  const obj = { ...(rawOffer as Record<string, unknown>) };
  if (!Array.isArray(obj.slices) || obj.slices.length === 0) {
    return rawOffer;
  }

  if (!obj.id && flightOffer.supplierOfferId) {
    obj.id = flightOffer.supplierOfferId;
  }

  if (
    (obj.total_amount === undefined || obj.total_amount === null || obj.total_amount === '') &&
    flightOffer.price !== undefined &&
    flightOffer.price !== null
  ) {
    obj.total_amount = String(flightOffer.price);
  }

  if (!obj.total_currency && flightOffer.currency) {
    obj.total_currency = flightOffer.currency;
  }

  const departureDate = flightOffer.departureDate ? new Date(flightOffer.departureDate) : null;
  const departureTimestamp =
    departureDate && !Number.isNaN(departureDate.getTime()) ? departureDate.toISOString() : null;

  if (Array.isArray(obj.slices)) {
    obj.slices = obj.slices.map((slice, sliceIndex) => {
      if (!slice || typeof slice !== 'object' || Array.isArray(slice)) return slice;
      const sliceObj = { ...(slice as Record<string, unknown>) };
      if (Array.isArray(sliceObj.segments)) {
        sliceObj.segments = sliceObj.segments.map((seg) => {
          if (!seg || typeof seg !== 'object' || Array.isArray(seg)) return seg;
          const segObj = { ...(seg as Record<string, unknown>) };
          if (!segObj.departing_at && sliceIndex === 0 && departureTimestamp) {
            segObj.departing_at = departureTimestamp;
          }
          return segObj;
        });
      }
      return sliceObj;
    });
  }

  // Only synthesize passengers if rawOffer did not define passengers at all (undefined/null)
  // and the flightOffer row has non-zero passenger counts.
  if ((obj.passengers === undefined || obj.passengers === null) && flightOffer) {
    const adults = Math.max(0, Number(flightOffer.adults ?? 0));
    const children = Math.max(0, Number(flightOffer.children ?? 0));
    const infants = Math.max(0, Number(flightOffer.infants ?? 0));
    const total = adults + children + infants;
    if (total > 0) {
      const generated: Array<{ id: string; type: string }> = [];
      for (let i = 0; i < adults; i++) {
        generated.push({ id: `pas_stored_${generated.length + 1}`, type: 'adult' });
      }
      for (let i = 0; i < children; i++) {
        generated.push({ id: `pas_stored_${generated.length + 1}`, type: 'child' });
      }
      for (let i = 0; i < infants; i++) {
        generated.push({ id: `pas_stored_${generated.length + 1}`, type: 'infant' });
      }
      obj.passengers = generated;
    }
  }

  return obj;
}
