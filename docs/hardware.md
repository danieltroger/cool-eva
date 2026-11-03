# Hardware and compatibility

## Connections

**The OBD2 version of the Korlan plugs straight into the diagnostic port on every Energica**, as Daniel confirmed on 2026-11-03. Pi + Korlan in the OBD2 port is the plug-and-play CAN connection; no matching diagnostic lead is needed.

The bike's other CAN connector can leave the OBD2 port free, but you must source its plug and solder the wiring. The repository does not document a name, pin map or wiring recipe for that connector. Daniel instead uses an **OBD2 Y-splitter**, bought online, when he needs the port for BMS configuration work.

The bike-side socket location and a suitable accessory power feed are not documented here. The CAN plug-and-play connection does not supply the Pi's power; see the separate power path below.

### Pi power and USB

The [Zero 2 W specification](https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/) identifies separate micro-USB data/OTG and power connections. Connect the Korlan's USB-A plug to the Pi's **USB** port with a micro-USB OTG adapter. Power the Pi through **PWR IN**. The [official Raspberry Pi power guidance](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#power-supply) calls for a 5.1 V supply; size it for the Pi and attached USB equipment.

Use a mains Pi supply for initial software setup. An on-bike installation needs a protected regulator from an appropriate low-voltage accessory circuit, suitable cabling and mounting. This repository does not document the regulator model, input fuse, switched feed or grounding arrangement. Never connect 12 V directly to the Pi, and do not tap the motorcycle's high-voltage system.

### Korlan connector pins

These are **adapter-side** assignments from [8devices' Korlan user guide, §2.1–2.3](https://wiki.8devices.com/_media/korlan:korlan_usb2can_user_guide.pdf), opened and read for this guide. They do not identify the wires or pins on an undocumented bike-side conversion lead. Follow the guide's connector drawings for numbering/viewing direction.

| Signal     | Korlan OBD2 connector | Korlan DB9 connector                               |
| ---------- | --------------------- | -------------------------------------------------- |
| CAN high   | 6                     | 7                                                  |
| CAN low    | 14                    | 2                                                  |
| CAN ground | 4 and 5               | 3 and 6                                            |
| Shield     | Not separately listed | 5, coupled to CAN ground as described in the guide |

The Korlan is powered by USB; its OBD2 pins other than 4, 5, 6 and 14 are unconnected. It has no internal termination. It needs a correctly terminated CAN network; do not add a termination resistor just because an adapter is attached to an existing vehicle network. Cool Eva configures its interface to 500 kbit/s; no separate Linux driver installation is needed on the documented Pi OS setup.

### Optional coolant equipment

A stock bike needs no coolant probes, fan or enabled SPI interface. The [cooling hardware guide](cooling-hardware.md) collects the supported parts, Pi pins, power limitations, boot configuration and CAD fittings. It states the mechanical and electrical details the repository has not yet documented.

### Bluetooth enrollment

The bike's Connectivity Hub holds one authorized-device pairing. Starting the service can enroll the Pi and replace a device already using that slot. Clearing the saved device from the bike's own dashboard allows pairing again. This is separate from CAN diagnostic requests and manual service actions. Read the current README's [before-first-start step](../README.md#5-before-the-first-service-start).

## Former README reference

> The following sections preserve the former README at commit `58c7eba` (2026-11-03), including dated measurements and limitations. For first installation, use the [current README](../README.md). Older validation/status claims are historical; the existing subsystem findings and current code take precedence.

## Original project overview

Telemetry for a **watercooled 2021 Energica Eva Ribelle**. A Raspberry Pi inside the bike logs the temperatures of a custom watercooling loop on the battery pack, **plus** the bike's own battery / charge / cell / drive telemetry read straight off the CAN bus — all into an encrypted, write-only ride log, surfaced as a live phone dashboard and (after decryption on the laptop) a Grafana dashboard for post-ride analysis.

## Hardware

- **Raspberry Pi Zero 2 W** running the app as a `systemd` service (Node.js, runs as root).
- **[8devices Korlan USB2CAN](https://shop.8devices.com/usb2can/korlan/)** plugged into the bike's OBD port → `can0` (in-kernel `usb_8dev`, no driver install). 500 kbit, 11-bit. The app reads broadcast frames _and_ actively polls standard OBD-II PIDs (**read-only** — no diagnostic writes).

  **Historical status:** "No diagnostic writes" describes the read poller, not the whole application: manual service actions and automatic charge control can transmit state-changing commands. See [what can change the bike](../README.md#what-can-change-the-bike).

- **2× MAX31865 + PT100 probes** over SPI — coolant **in** and **out** of the custom battery watercooling loop. **Optional**: this is the one piece of hardware most Energicas don't have. Without it everything else works and the coolant tiles simply don't appear.
- **Networking:** the Pi joins my **phone's hotspot**, so it's reachable at **`http://cool-eva.local`** from the phone's browser. It's a bit janky (have to open hotspot page in phone settings for ~20s at the start of every ride), but it works for an at-a-glance dash while riding/charging.

### If you have a stock Energica

The Korlan alone gets you most of this. Everything under [What it logs](signals.md#what-it-logs) works on a stock, unmodified bike except the sections explicitly marked otherwise — no watercooling loop, no probes and no BMS reflash required. Set `COOLANT_ENABLED=0` and the coolant probes are never attempted.

Two caveats worth knowing before you spend money:

- It is developed against a **2021 Eva Ribelle**. The pack shape is hardcoded in places — 81 cells in 11 modules, a 400 A discharge and 120 A regen ceiling, a 130 kW power bar — and nothing detects a mismatch. On another bike in the same pack family the readings are right and those scale limits may not be; on a differently-packed model (Experia) treat the whole thing as untested. Reports welcome. The **VCU parameter names are not** in that category any more: all 28 of Energica's parameter tables are shipped and the bike's own `TABLE_TYPE` picks one, so [that half works on your bike](vcu-parameters.md#vcu-parameters-by-name) whichever it is — and if your table is newer than the 28, [adding it is one command](vcu-parameters.md#adding-your-bikes-vcu-parameter-table).
- The bike's **CAN bus is not a toy**. This app only ever reads, but it does transmit standard OBD-II _read_ requests to do so (see [Notes](vcu-parameters.md#notes)). If you would rather it never spoke at all, `OBD_ENABLED=0` makes it passive-only.

  **Historical status:** "This app only ever reads" predates the CAN write features. The [current safety guide](../README.md#what-can-change-the-bike) explains their triggers and gates.

## Notes — Bluetooth enrollment

- The one thing that _does_ write to the bike is the Bluetooth handshake: enrolling with the Connectivity Hub claims its single authorised-device slot, and after several unanswered attempts the client also tries the hub's own address. If the bike is already paired to something else, that pairing can be replaced, and the way back is clearing the stored device from the bike's own dashboard. `BLE_ENABLED=0` avoids the whole question.

**Historical status:** Bluetooth enrollment is no longer the only bike-changing operation. For CAN actions and the temporary Bluetooth opt-out, use the [current first-start and safety instructions](../README.md#5-before-the-first-service-start).
