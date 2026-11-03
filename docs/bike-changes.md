# What can change the bike

Reading telemetry includes transmitting diagnostic **read requests**; this is not a completely silent tap. Bluetooth enrollment changes the hub's pairing as explained [before first start](manual-install.md#5-before-the-first-service-start).

Manual charging and service actions use a two-tap arm and vehicle-state checks. They can change charge limits, stop charging, write calibration parameters, set a service point, sync the bike's clock, clear trouble codes or **Reset the VCU** (restart both processors). Parameter writes also require a matching parameter table. Some actions are irreversible; the gates do not establish that a calibration value is suitable for your motorcycle.

<!-- for-now: #317 -->

For now, state-changing CAN commands also require `SERVICE_WRITE_ENABLED=1`; leave it unset for a first installation.

**Automatic DC charge management starts in automatic mode** and can adjust the requested current without a confirmation for each adjustment. When the dashboard setting **"Allow automatic current reduction"** is available, it defaults **on**. On a stock BMS configuration, it only changes the maximum-current figure the bike's dash shows; it does not control the actual DC charging current. See [Daniel's stock-bike observation](charge-auto.md#stock-bms-configuration) and the [automatic charging details](charge-auto.md).

<!-- for-now: #317 -->

For now, use the Charge tab's **"Automatic charge current"** tile (visible during a DC charge when writes are enabled) for session controls, or set `CHARGE_AUTO_ENABLED=0` in `/etc/default/cool-eva` to disable the controller across boots.

The optional fan can start by itself once enabled. Keep hands clear while it has power; see the [cooling hardware guide](cooling-hardware.md).

<!-- for-now: #317 -->

For now, a fitted fan is enabled with `FAN_ENABLED=1`, after the hardware and boot configuration in that guide are complete.

## Bluetooth pairing before startup

Cool Eva enrolls the Pi with the motorcycle's Bluetooth hub. The hub remembers **one authorized device**, so this can replace the pairing you already use. To pair a previous device again, clear the stored device from the bike's own dashboard first.

<!-- for-now: #317 -->

For now, prevent that enrollment by adding `BLE_ENABLED=0` to `/etc/default/cool-eva` before starting the service; edit the file with `sudo nano /etc/default/cool-eva`.
