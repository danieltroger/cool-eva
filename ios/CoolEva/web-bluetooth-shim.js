// The slice of Web Bluetooth that public/lib/ble-link.js uses, provided by the iOS app
// over CoreBluetooth (BleBridge.swift). Injected at document start, before any module
// runs, so ble-link.js finds `navigator.bluetooth` and never knows it is in an app.
// Shape follows the typedefs at the top of ble-link.js; nothing more is implemented.
//
// Calls go to Swift through a reply-capable message handler, so each one is a promise.
// Swift rejects with "<ErrorName>: <message>", which becomes a DOMException of that name —
// ble-link.js tells a dismissed chooser from a fault by `error.name === "NotFoundError"`.
(() => {
  const handler = window.webkit.messageHandlers.coolEvaBle;

  async function call(op, args = {}) {
    try {
      return await handler.postMessage({ op, ...args });
    } catch (error) {
      const text = String(error && error.message ? error.message : error);
      const match = /^(\w+Error): ([\s\S]*)$/.exec(text);
      throw match ? new DOMException(match[2], match[1]) : new DOMException(text, "NetworkError");
    }
  }

  function toBase64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index++) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }

  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  /** One object per UUID for the page's lifetime, as Chrome does: ble-link.js keys its listener on identity. */
  const characteristics = new Map();
  /** Likewise per peripheral identifier. */
  const devices = new Map();
  let currentDevice = null;

  class Characteristic extends EventTarget {
    constructor(uuid) {
      super();
      this.uuid = uuid;
      this.value = undefined;
    }
    async readValue() {
      const bytes = fromBase64(await call("read", { characteristic: this.uuid }));
      this.value = new DataView(bytes.buffer);
      return this.value;
    }
    async writeValueWithResponse(value) {
      const bytes =
        value instanceof Uint8Array ? value : new Uint8Array(ArrayBuffer.isView(value) ? value.buffer : value);
      await call("write", { characteristic: this.uuid, value: toBase64(bytes) });
    }
    async startNotifications() {
      await call("startNotifications", { characteristic: this.uuid });
      return this;
    }
  }

  const service = {
    async getCharacteristic(uuid) {
      const key = uuid.toLowerCase();
      await call("characteristic", { characteristic: key });
      if (!characteristics.has(key)) {
        characteristics.set(key, new Characteristic(key));
      }
      return characteristics.get(key);
    },
  };

  const gatt = {
    connected: false,
    async connect() {
      await call("connect");
      gatt.connected = true;
      return gatt;
    },
    disconnect() {
      call("disconnect").catch(error => console.warn("ble shim: disconnect failed", error));
    },
    async getPrimaryService(uuid) {
      await call("service", { service: uuid.toLowerCase() });
      return service;
    },
  };

  class Device extends EventTarget {
    constructor(id, name) {
      super();
      this.id = id;
      this.name = name || undefined;
      this.gatt = gatt;
    }
  }

  // Swift's way back in. Called in order, on the page's main thread.
  window.__coolEvaBle = {
    notification(uuid, base64) {
      const characteristic = characteristics.get(uuid);
      if (!characteristic) return;
      const bytes = fromBase64(base64);
      characteristic.value = new DataView(bytes.buffer);
      characteristic.dispatchEvent(new Event("characteristicvaluechanged"));
    },
    disconnected() {
      gatt.connected = false;
      if (currentDevice) {
        currentDevice.dispatchEvent(new Event("gattserverdisconnected"));
      }
    },
  };

  Object.defineProperty(navigator, "bluetooth", {
    configurable: false,
    value: {
      async requestDevice(options) {
        const services = (options.filters || [])
          .flatMap(filter => filter.services || [])
          .map(uuid => uuid.toLowerCase());
        const chosen = await call("requestDevice", { services });
        if (!devices.has(chosen.id)) {
          devices.set(chosen.id, new Device(chosen.id, chosen.name));
        }
        currentDevice = devices.get(chosen.id);
        return currentDevice;
      },
    },
  });

  // What public/ checks to know it is inside the app: BLE mode, and native file saving.
  window.coolEvaNative = Object.freeze({
    platform: "ios",
    saveFile: (name, bytes, mimeType) => call("saveFile", { name, mimeType, value: toBase64(bytes) }),
  });
})();
