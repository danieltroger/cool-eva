import type { IncomingMessage, ServerResponse } from "node:http";
import { SIGNALS } from "../can/registry.ts";
import { activeParameterTable, parameterTable, type VcuMicro } from "../vcu/param-table.ts";
import { datatypeBounds, writeTargetProblemIn, writeTargets } from "../vcu/write-targets.ts";
import { parameterDisplay } from "../vcu/parameter-display.ts";

export function handleServiceCatalogue(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" });
    res.end("use GET to browse the Service catalogue\n");
    return;
  }
  const body = Buffer.from(JSON.stringify(serviceCatalogue()));
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export interface ServiceParameter {
  index: number;
  name: string;
  micro: VcuMicro;
  group: string;
  minimum: number;
  maximum: number;
  writable: boolean;
  scale: number;
  unit: string;
  /** The reference table carries another bike's values, not factory defaults. */
  stock: number | null;
}

export interface ServiceSignal {
  key: string;
  group: string;
  unit: string;
}

export interface ServiceCatalogue {
  tableType: number;
  parameters: ServiceParameter[];
  signals: ServiceSignal[];
}

/** Metadata only; neither this function nor its HTTP handler takes a bus or a snapshot. */
export function serviceCatalogue(): ServiceCatalogue {
  const table = activeParameterTable();
  const targets = new Map(writeTargets().map(target => [target.index, target]));
  return {
    tableType: table.tableType,
    parameters: parameterTable().map(parameter => {
      const target = targets.get(parameter.index);
      const writable =
        target?.name === parameter.name &&
        target.control.kind === "number" &&
        writeTargetProblemIn(target, table) === null;
      const bounds = writable && target.control.kind === "number" ? target.control : datatypeBounds(parameter);
      return {
        index: parameter.index,
        name: parameter.name,
        micro: parameter.micro,
        group: parameter.section ?? "Other parameters",
        minimum: bounds.min,
        maximum: bounds.max,
        writable,
        ...parameterDisplay(parameter.name),
        stock: null,
      };
    }),
    signals: SIGNALS.map(({ key, group, unit }) => ({ key, group, unit })),
  };
}
