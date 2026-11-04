import { readFile, writeFile } from "node:fs/promises";

export async function prepareQemuDeviceTree(source: string, destination: string): Promise<void> {
  const input = await readFile(source);
  if (input.readUInt32BE(0) !== 0xd00dfeed) {
    throw new Error("Invalid device tree");
  }
  const structureOffset = input.readUInt32BE(8);
  const stringsOffset = input.readUInt32BE(12);
  const strings = input.subarray(stringsOffset, stringsOffset + input.readUInt32BE(32));
  const pieces: Buffer[] = [];
  const nodes: string[] = [];
  let offset = structureOffset;
  while (offset < stringsOffset) {
    const token = input.readUInt32BE(offset);
    const start = offset;
    offset += 4;
    if (token === 1) {
      const end = input.indexOf(0, offset);
      nodes.push(input.subarray(offset, end).toString());
      offset = aligned(end + 1);
    } else if (token === 2) {
      nodes.pop();
    } else if (token === 3) {
      const length = input.readUInt32BE(offset);
      const nameOffset = input.readUInt32BE(offset + 4);
      const name = strings.subarray(nameOffset, strings.indexOf(0, nameOffset)).toString();
      let value = input.subarray(offset + 8, offset + 8 + length);
      offset = aligned(offset + 8 + length);
      // QEMU lacks the GPU power domains; probing their registers aborts the stock kernel.
      if (name === "power-domains") {
        continue;
      }
      if (name === "compatible" && value.toString().includes("brcm,bcm2835-pm")) {
        value = Buffer.from("qemu,unimplemented\0");
      }
      if (name === "status" && nodes.at(-1) === "serial@7e201000") {
        value = Buffer.from("okay\0");
      }
      if (name === "status" && nodes.at(-1) === "bluetooth") {
        value = Buffer.from("disabled\0");
      }
      const property = Buffer.alloc(12 + aligned(value.length));
      property.writeUInt32BE(3, 0);
      property.writeUInt32BE(value.length, 4);
      property.writeUInt32BE(nameOffset, 8);
      value.copy(property, 12);
      pieces.push(property);
      continue;
    } else if (token !== 4 && token !== 9) {
      throw new Error(`Unexpected device-tree token ${token}`);
    }
    pieces.push(input.subarray(start, offset));
    if (token === 9) {
      break;
    }
  }
  const structure = Buffer.concat(pieces);
  const result = Buffer.concat([input.subarray(0, structureOffset), structure, strings]);
  result.writeUInt32BE(result.length, 4);
  result.writeUInt32BE(structureOffset + structure.length, 12);
  result.writeUInt32BE(structure.length, 36);
  await writeFile(destination, result);
}

function aligned(bytes: number): number {
  return (bytes + 3) & ~3;
}
