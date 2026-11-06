# Phone dashboard

You can also [connect over Bluetooth](connecting-over-bluetooth.md): Chrome on Android, Bluefy on iPhone, or the experimental [Xcode-built iOS app](ios-app.md). The app has not been tested on a phone. Bluetooth avoids waiting for the Pi to join a hotspot; first configure the Pi's generated Bluetooth key over Wi-Fi. The Dashboard Bluetooth setting requires 32 random bytes encoded as 64 lowercase hex characters; the [Bluetooth setup guide](connecting-over-bluetooth.md#1-set-up-the-pi-once) explains generation and transfer. Update the Pi and phone page/app together to protocol 2, including rebuilding the app's bundled dashboard. A browser needs to load the hosted page online before using it offline; the app bundles it. The Pi still needs internet over Wi-Fi for software updates.

The hosted copy is **[https://cool-eva.athegen.com](https://cool-eva.athegen.com)**, on its own origin. Riders moving from the old Cloudflare Worker or GitHub Pages address must **re-enter their saved Bluetooth access code** at this address; browser storage does not transfer between origins. After re-entry, riders may clear the old site's browser data. Other hosts need an exact dedicated-origin allowlist entry; see [hosting and fork instructions](ble-server.md#hosted-pages-and-origin-isolation).

On the phone hosting the hotspot, or another device on the same network, open **[http://cool-eva.local](http://cool-eva.local)**. If the name fails, use `http://<pi-ip>/`, with the address from the [SSH step](manual-install.md#2-connect--on-your-computer). The dashboard runs on the Pi; internet access is not needed to view it.

- **Ride:** speed, power, battery temperature and charge.
- **Charge:** charging current, voltage, power and battery condition.
- **Faults:** named active and stored trouble codes.
- **Hypermile / All:** battery headroom and a fuller view of the available readings.

Coolant temperatures need the optional probes. Detailed individual cell/module readings need a custom BMS configuration; their absence on a stock bike is normal. Keep your phone interaction for when you are parked.

For later software updates, use **Menu → Update**. [Updating and troubleshooting the installation](deploy.md#running-it) explains dependency changes and manual recovery. Do not routinely run `npm install` on an already working Pi.
