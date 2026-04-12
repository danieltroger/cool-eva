const MAX31865 = require('max31865');

const sensor = new MAX31865(0, 0, {
  rtdNominal: 100,   // PT100
  refResistor: 430,  // Adafruit board
  wires: 4,
});

async function main() {
  await sensor.init();
  const tempC = await sensor.getTemperature();
  console.log(`Temperature: ${tempC.toFixed(2)} °C`);
}

main().catch(console.error);
