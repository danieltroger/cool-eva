# Optional coolant probes and radiator fan

A stock Energica needs none of this hardware. This page covers the temperature probes and fan used with this project's custom coolant loop. It is not a complete guide to converting a battery pack to watercooling.

## Parts

| Part | What this installation uses | Evidence |
| --- | --- | --- |
| Temperature interface | Two MAX31865 boards, each with a 430 Ω reference resistor | [`src/sensors/max31865.ts`](../src/sensors/max31865.ts), [`INSTALL.md` §0](../INSTALL.md#0-hardware) |
| Coolant probes | Two PT100 probes, nominal 100 Ω, wired as **4-wire** sensors | Same configuration; one inlet and one outlet |
| Radiator fan | SPAL VA69A-A101-87S, 12 V brushed motor | [`fan-control.md` §1](fan-control.md#1-hardware) |
| Motor driver | IBT-2 module: two BTS7960B half-bridges and a 74HC244 logic buffer | [`fan-control.md` §1–2](fan-control.md#1-hardware) |
| Fan power and protection | The existing notes say **“The bike's fan circuit is on a 10 A blade fuse”** | [`fan-control.md` §4](fan-control.md#kick-start-100--for-1500-ms-from-rest); the feed, fuse location and loom specification are not documented |
| Mechanical fittings | Andy's inlet/outlet transfer models and related files under `cad/` | See [mechanical parts](#mechanical-parts-and-probe-sizes) below |

The 10 A fuse describes this bike's circuit. It is not a verified fuse recommendation for a different fan, power source or cable. Which circuit feeds the fan is still undocumented.

## Connect the two probes to SPI0

The app uses **SPI0 CE0 for the inlet** (`/dev/spidev0.0`) and **SPI0 CE1 for the outlet** (`/dev/spidev0.1`). Both boards share the clock and data lines; their chip-select lines are separate. The sensor settings are fixed to PT100, 430 Ω reference and 4-wire operation in [`max31865.ts`](../src/sensors/max31865.ts).

These are **physical header pin numbers**, with the GPIO names alongside. The Pi-side assignments come from the [official Raspberry Pi GPIO pinout and pin-function table](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#gpio-pinout-map), opened for this guide. Use the diagram there to identify pin 1 and the viewing orientation.

| SPI0 signal        | Pi GPIO | Physical header pin | Connects to                                             |
| ------------------ | ------- | ------------------- | ------------------------------------------------------- |
| MOSI, data from Pi | GPIO10  | 19                  | Both boards' SPI data input                             |
| MISO, data to Pi   | GPIO9   | 21                  | Both boards' SPI data output                            |
| SCLK, clock        | GPIO11  | 23                  | Both boards' SPI clock                                  |
| CE0                | GPIO8   | 24                  | Inlet board's chip select                               |
| CE1                | GPIO7   | 26                  | Outlet board's chip select                              |
| Ground             | GND     | 6, for example      | Boards' signal ground                                   |
| 3.3 V rail         | 3V3     | 1 or 17             | Available Pi rail; see the board-power limitation below |

**The repository does not document the exact MAX31865 board terminal labels, supply wiring, 4-wire probe colors, or the required board jumpers.** The table establishes the Pi's SPI connections; it does not establish a particular breakout board's VIN requirements. Check those against the actual board before connecting its power or probe terminals. Pi GPIO signals are 3.3 V; do not feed them 5 V or the fan's 12 V supply.

Enable SPI only after the probes are wired: `sudo raspi-config` → Interface Options → SPI → Enable, then reboot. The two device paths above should appear. With SPI off, a stock installation continues without probes; with SPI on and no sensor attached, reads can look successful while producing an impossible temperature. The app reports/retries such faults rather than treating them as real coolant temperatures.

<!-- for-now: #317 -->

For now, `COOLANT_ENABLED=0` in `/etc/default/cool-eva` skips probe attempts; a wired probe installation uses the current default instead.

## Connect the fan driver to the Pi

Use the existing [IBT-2 pin map](fan-control.md#2-pin-map). **Logic VCC is 3.3 V**, separate from the motor's 12 V supply. At 5 V VCC the buffer's input-high threshold is above the Pi's GPIO output, so 5 V logic power is not interchangeable here.

| IBT-2 connection | Pi GPIO / rail        | Physical header pin |
| ---------------- | --------------------- | ------------------- |
| VCC              | 3V3                   | 17                  |
| GND              | GND                   | 14                  |
| RPWM             | GPIO18, hardware PWM0 | 12                  |
| R_EN             | GPIO17                | 11                  |
| L_EN             | GPIO27                | 13                  |

`LPWM`, `R_IS` and `L_IS` are left unconnected in this installation. There is no fan tachometer or connected current measurement, so a displayed duty percentage tells you what the Pi commanded, not whether the rotor is turning.

The motor needs a separate 12 V power path through its driver and the bike's fused fan circuit. **Do not power the motor from the Pi header.** The source notes do not identify the motorcycle feed or the driver/motor connector pinout, wire sizes, or the complete power/ground loom. Those must be established before building this circuit; the GPIO table alone is not a complete motor-wiring diagram.

## Configure and enable the fan

Before enabling a wired fan, follow [`INSTALL.md` §1](../INSTALL.md#1-base-os-setup) and [`fan-control.md` §5](fan-control.md#5-kernel-setup-on-the-pi) for `raspi-utils`/`pinctrl` and these boot settings:

```ini
dtoverlay=pwm,pin=18,func=2
gpio=17,op,dl
gpio=27,op,dl
```

They go in `/boot/firmware/config.txt` and need a reboot. The two enables start LOW. Both LOW is standby; leaving both HIGH at zero duty brakes the motor instead of letting it coast. The app discovers the PWM chip number, so do not hardcode `pwmchip0`. Pi models with analogue audio have additional PWM requirements in the linked guide.

**Enabling the fan lets it start automatically.** Its automatic curve follows pack temperature; the slider can take over. Keep hands out of the duct while powered: killing the process can leave the bridge driving until the service restarts. Leave the fan disabled on a stock installation. When the probe and fan settings are available in the dashboard, both default OFF; enable them only with the corresponding hardware installed.

<!-- for-now: #317 -->

For now, enabling a wired fan requires `FAN_ENABLED=1` in `/etc/default/cool-eva` and a service restart, after the boot configuration above is complete.

The start-up kick is an anti-stiction measure, **not proven fuse protection**. Locked-rotor current and the actual 12 V rail under load have not been measured. See [the electrical reasoning and known gaps](fan-control.md#8-known-gaps) before adapting the circuit.

## Mechanical parts and probe sizes

The repository contains Andy's transfer fittings as editable SolidWorks parts and STEP exports:

| Files under `cad/` | What is established |
| --- | --- |
| [`C-3P3W827551A_TransferInlet2.STEP`](../cad/C-3P3W827551A_TransferInlet2.STEP) and [`.SLDPRT`](../cad/C-3P3W827551A_TransferInlet2.SLDPRT) | Inlet transfer part; the STEP includes a solid named `base-oring` |
| [`C-3P3W827551A_TransferOutlet2.STEP`](../cad/C-3P3W827551A_TransferOutlet2.STEP) and [`.SLDPRT`](../cad/C-3P3W827551A_TransferOutlet2.SLDPRT) | Outlet transfer part |
| [`C-3P3W827551A_Transfer_Terminate.STEP`](../cad/C-3P3W827551A_Transfer_Terminate.STEP) and [`.SLDPRT`](../cad/C-3P3W827551A_Transfer_Terminate.SLDPRT) | A termination part is present; its installation is not described |
| [`TransferShim.STEP`](../cad/TransferShim.STEP) and [`.SLDPRT`](../cad/TransferShim.SLDPRT) | A related model is present, with a solid named `o-ring`; the name alone is not an O-ring purchase specification |
| [`Transfer_connectors.pdf`](../cad/Transfer_connectors.pdf) and [`.SLDDRW`](../cad/Transfer_connectors.SLDDRW) | Older drawing, with M16 × 1.0 thread callouts |
| [`Top-Plate.STEP`](../cad/Top-Plate.STEP), [`bottom-plate.STEP`](../cad/bottom-plate.STEP), their SolidWorks files, [`bottom-plate.pdf`](../cad/bottom-plate.pdf), and [`Assem1.SLDASM`](../cad/Assem1.SLDASM) | Plates and an assembly exist; **their purpose is not documented**. They cannot be identified here as an enclosure or a cooling plate |

**The drawings predate the current parts.** The readable drawings were last changed at `c84cd85`; later revisions changed the part/model files. `c607a03` records an O-ring size correction, and `d150de7` records revised O-ring and thermometer sizes. Current geometry is in the STEP/SolidWorks parts, without a current dimensioned drawing.

The code establishes **PT100, 4-wire, 100 Ω nominal** electrically. It does **not** specify the current probe's physical diameter, insertion length, fitting/thread or part number, nor an O-ring's inside diameter, cross-section or material. Those are not recoverable as a reliable shopping list from an old drawing or a feature name. Do not order the older 16 mm OD O-ring merely from its commit message. Confirm the current probe and seal against the current CAD before manufacturing or ordering.

## Not documented yet

- A complete motor-power loom: accessory feed, fuse location, connector assignments, wire sizes and power-ground routing.
- The exact MAX31865 breakout power/terminal wiring and probe-wire colors.
- A current dimensioned probe/O-ring specification, sealing material, manufacturing tolerances and an installation drawing for the current fittings.
- The purpose and installation of the plates, assembly and other related CAD parts.
- A complete bill of materials or installation procedure for the pump, radiator, hoses and battery coolant-loop conversion.

These gaps matter before making hardware. The software settings do not establish that a custom cooling installation is electrically or mechanically correct.
