// @ts-check
// Daniel approved this map; keep its destinations together for feedback on the built screens.
export const SETTINGS_MAP = [
  { key: "phone", title: "This phone", detail: "Screen · Units" },
  { key: "bike", title: "Bike setup", detail: "Coolant probes · Radiator fan · Custom BMS" },
  { key: "charging", title: "Charging", detail: "Allow automatic current reduction" },
  { key: "connections", title: "Connections", detail: "Wi-Fi · Bluetooth" },
  { key: "recording", title: "Ride recording", detail: "Recording status · Public key · Backup help" },
  { key: "software", title: "Cool Eva", detail: "Version · Update" },
  { key: "advanced", title: "Advanced", detail: "Data location · Recording and service directories" },
];

/** @type {Record<string, string>} */
export const SETTINGS_PAGE_TITLES = {
  ...Object.fromEntries(SETTINGS_MAP.map(item => [item.key, item.title])),
};
