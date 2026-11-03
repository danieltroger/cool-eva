# Phone dashboard

You can also [connect over Bluetooth](connecting-over-bluetooth.md): Chrome on Android, Bluefy on iPhone, or the experimental [Xcode-built iOS app](ios-app.md). The app has not been tested on a phone. Bluetooth avoids waiting for the Pi to join a hotspot; first configure the Pi's BLE secret over Wi-Fi. A browser needs to load the hosted page online before using it offline; the app bundles it. The Pi still needs internet over Wi-Fi for software updates.

On the phone hosting the hotspot, or another device on the same network, open **[http://cool-eva.local](http://cool-eva.local)**. If the name fails, use `http://<pi-ip>/`, with the address from the [SSH step](manual-install.md#2-connect--on-your-computer). The dashboard runs on the Pi; internet access is not needed to view it.

- **Ride:** speed, power, battery temperature and charge.
- **Charge:** charging current, voltage, power and battery condition.
- **Faults:** named active and stored trouble codes.
- **Hypermile / All:** battery headroom and a fuller view of the available readings.

Coolant temperatures need the optional probes. Detailed individual cell/module readings need a custom BMS configuration; their absence on a stock bike is normal. Keep your phone interaction for when you are parked.

For later software updates, use **Menu → Update**. [Updating and troubleshooting the installation](deploy.md#running-it) explains dependency changes and manual recovery. Do not routinely run `npm install` on an already working Pi.
