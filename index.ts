import MAX31865 from 'max31865';

interface SensorOptions {
  rtdNominal: number;
  refResistor: number;
  wires: 2 | 3 | 4;
}

interface Sensor {
  init(): Promise<void>;
  getTemperature(): Promise<number>;
}

const sensor: Sensor = new MAX31865(0, 0, {
  rtdNominal: 100,   // PT100
  refResistor: 430,  // Adafruit board
  wires: 4,
} satisfies SensorOptions);

await sensor.init();
const tempC: number = await sensor.getTemperature();
console.log(`Temperature: ${tempC.toFixed(2)} °C`);
