// Synthetic reads/readbacks for every catalogue row; the catalogue and wire templates come from typed TS.
const SERVICE_PARAMETERS = structuredClone(SERVER.serviceParameters);
const SERVICE_PARAMETER_REQUESTS = [];
function serviceParameterResponse(address, options, method) {
  if (address.pathname === "/vcu-params") {
    return new Response(JSON.stringify(SERVICE_PARAMETERS.params), { headers: { "Content-Type": "application/json" } });
  }
  if (address.pathname === "/vcu-probe" && method === "POST") {
    const reading = SERVICE_PARAMETERS.probes[address.searchParams.get("index")];
    const allowed =
      GATE.safe && reading?.target === address.searchParams.get("target") && address.searchParams.get("bank") === "1";
    return new Response(
      JSON.stringify({
        reading: allowed ? reading : null,
        message: allowed ? null : "Synthetic read refusal",
        gate: GATE,
        targets: SERVICE_PARAMETERS.targets,
      }),
      { status: allowed ? 200 : 409, headers: { "Content-Type": "application/json" } }
    );
  }
  const action = address.searchParams.get("action");
  if (address.pathname === "/vcu-write" && method === "POST" && action === "reset-vcu") {
    const succeeded =
      GATE.safe &&
      WRITE_STATUS.enabled &&
      GATE.chargingEvidence === null &&
      options.headers?.["X-Cool-Eva"] === "service-write" &&
      address.searchParams.get("confirm") === "reset-vcu";
    return new Response(
      JSON.stringify({
        status: writeStatus(address.searchParams),
        result: succeeded ? SERVICE_RESET_RESULT : null,
        message: succeeded ? null : "Synthetic reset refused",
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
  if (address.pathname === "/vcu-write" && method === "POST" && (action === "parameter" || action === "parameters")) {
    const entries =
      action === "parameter"
        ? [[address.searchParams.get("name"), address.searchParams.get("value"), address.searchParams.get("expected")]]
        : address.searchParams.getAll("w").map(entry => entry.split(":"));
    const writes = entries.map(([name, wanted, expected]) => {
      const parameter = __TABLES["/service-catalogue"].parameters.find(
        parameter => parameter.name === name && parameter.writable
      );
      const reading = parameter ? SERVICE_PARAMETERS.probes[String(parameter.index)] : null;
      const value = Number(wanted);
      const succeeded =
        options.headers?.["X-Cool-Eva"] === "service-write" &&
        WRITE_STATUS.enabled &&
        WRITE_STATUS.tableGate.writesAllowed &&
        GATE.safe &&
        parameter &&
        reading &&
        Number(expected) === reading.value &&
        Number.isInteger(value) &&
        value >= parameter.minimum &&
        value <= parameter.maximum;
      if (succeeded) {
        reading.value = value;
        const width = reading.rawHex.replaceAll(" ", "").length / 2;
        reading.unsigned = value < 0 ? value + 2 ** (width * 8) : value;
        reading.signed =
          reading.unsigned >= 2 ** (width * 8 - 1) ? reading.unsigned - 2 ** (width * 8) : reading.unsigned;
        reading.rawHex = reading.unsigned
          .toString(16)
          .padStart(width * 2, "0")
          .toUpperCase()
          .match(/../g)
          .join(" ");
        const row =
          SERVICE_PARAMETERS.params.state === "snapshot"
            ? SERVICE_PARAMETERS.params.snapshot.rows.find(row => row.index === parameter.index)
            : null;
        if (row) {
          row.value = value;
          row.rawHex = reading.rawHex;
          row.unsigned = reading.unsigned;
        }
      }
      return {
        name,
        status: succeeded ? "written" : "stale-precondition",
        message: succeeded ? "Synthetic confirmed write" : "Synthetic write refusal",
        succeeded: !!succeeded,
        onBike: reading ? { name: reading.name, value: reading.value, rawHex: reading.rawHex } : null,
      };
    });
    const succeeded = writes.every(write => write.succeeded);
    const result = {
      ...SERVICE_PARAMETER_RESULT,
      succeeded,
      status: succeeded ? "written" : "stale-precondition",
      onBike: action === "parameter" ? writes[0].onBike : undefined,
      writes: action === "parameters" ? writes : undefined,
    };
    return new Response(JSON.stringify({ status: writeStatus(address.searchParams), result, message: null }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

const SERVICE_PARAMETER_RESULT = {
  action: "parameter-write",
  status: "written",
  message: "Synthetic confirmed write",
  succeeded: true,
};

const SERVICE_RESET_RESULT = {
  action: "reset-vcu",
  status: "reset",
  message: "Synthetic bike restart",
  succeeded: true,
};
