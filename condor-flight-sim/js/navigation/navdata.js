/**
 * Navigation database per region: VOR/DME stations and VFR/IFR fixes.
 * Identifiers, frequencies and positions are simulator data (approximate / partly fictional).
 */
(function (SIM) {
  'use strict';

  SIM.NavData = {
    chile: {
      vors: [
        { ident: 'SCL', name: 'Santiago', freq: 116.2, lat: -33.378, lon: -70.802 },
        { ident: 'TBN', name: 'Tobalaba', freq: 115.6, lat: -33.452, lon: -70.556 },
        { ident: 'CRV', name: 'Curacaví', freq: 113.4, lat: -33.422, lon: -71.098 },
        { ident: 'VLP', name: 'Valparaíso', freq: 112.7, lat: -32.958, lon: -71.465 },
        { ident: 'SNO', name: 'Santo Domingo', freq: 113.9, lat: -33.645, lon: -71.598 },
        { ident: 'AND', name: 'Andes', freq: 117.1, lat: -32.84, lon: -70.17 },
        { ident: 'DOZ', name: 'Mendoza', freq: 114.3, lat: -32.82, lon: -68.78 },
      ],
      fixes: [
        { ident: 'CAREN', name: 'Laguna Carén', lat: -33.438, lon: -70.85 },
        { ident: 'LPRAD', name: 'Túnel Lo Prado', lat: -33.43, lon: -70.935 },
        { ident: 'PUDAH', name: 'Pudahuel', lat: -33.445, lon: -70.745 },
        { ident: 'MAIPU', name: 'Maipú', lat: -33.51, lon: -70.765 },
        { ident: 'PENAF', name: 'Peñaflor', lat: -33.61, lon: -70.88 },
        { ident: 'TALAG', name: 'Talagante', lat: -33.665, lon: -70.93 },
        { ident: 'COLNA', name: 'Colina', lat: -33.2, lon: -70.672 },
        { ident: 'CBLNC', name: 'Casablanca', lat: -33.318, lon: -71.405 },
        { ident: 'QNTAY', name: 'Quintay', lat: -33.19, lon: -71.69 },
        { ident: 'CONCN', name: 'Concón', lat: -32.928, lon: -71.52 },
        { ident: 'QLOTA', name: 'Quillota', lat: -32.88, lon: -71.25 },
        { ident: 'LIBRT', name: 'Paso Los Libertadores', lat: -32.82, lon: -70.1 },
        { ident: 'USPLT', name: 'Uspallata', lat: -32.59, lon: -69.35 },
        { ident: 'ELPLO', name: 'Cerro El Plomo', lat: -33.235, lon: -70.214 },
      ],
      centers: [{ name: 'Santiago Center', freq: 125.1, lat: -33.39, lon: -70.79, range: 200 }],
    },
    sfbay: {
      vors: [
        { ident: 'SFO', name: 'San Francisco', freq: 115.8, lat: 37.6195, lon: -122.3736 },
        { ident: 'OAK', name: 'Oakland', freq: 116.8, lat: 37.7259, lon: -122.2236 },
        { ident: 'SAU', name: 'Sausalito', freq: 116.2, lat: 37.855, lon: -122.523 },
        { ident: 'OSI', name: 'Woodside', freq: 113.9, lat: 37.392, lon: -122.281 },
        { ident: 'SJC', name: 'San Jose', freq: 114.1, lat: 37.375, lon: -121.945 },
        { ident: 'PYE', name: 'Point Reyes', freq: 113.7, lat: 38.08, lon: -122.868 },
      ],
      fixes: [
        { ident: 'GGATE', name: 'Golden Gate', lat: 37.818, lon: -122.478 },
        { ident: 'CANDL', name: 'Candlestick', lat: 37.712, lon: -122.385 },
        { ident: 'BMONT', name: 'Belmont Slough', lat: 37.53, lon: -122.24 },
        { ident: 'SUNOL', name: 'Sunol', lat: 37.59, lon: -121.88 },
        { ident: 'MTDBL', name: 'Mount Diablo', lat: 37.882, lon: -121.914 },
        { ident: 'HMBAY', name: 'Half Moon Bay coast', lat: 37.46, lon: -122.47 },
      ],
      centers: [{ name: 'NorCal Approach', freq: 135.65, lat: 37.62, lon: -122.37, range: 120 }],
    },
  };
})(window.SIM);
