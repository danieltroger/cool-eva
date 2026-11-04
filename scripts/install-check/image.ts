import { constants } from "node:fs";
import { copyFile, mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

export async function extractPiBootFiles(imagePath: string, outputDirectory: string): Promise<void> {
  const image = await open(imagePath, "r");
  try {
    const partition = (await readBytes(image, 0, 512)).readUInt32LE(454) * 512;
    const boot = await readBytes(image, partition, 512);
    const sectorBytes = boot.readUInt16LE(11);
    const reservedSectors = boot.readUInt16LE(14);
    const fatSectors = boot.readUInt32LE(36);
    const clusterBytes = sectorBytes * boot[13];
    if (sectorBytes !== 512 || clusterBytes < 512 || clusterBytes > 65536 || fatSectors > 32768) {
      throw new Error("The pinned image does not have the expected FAT32 boot partition");
    }
    const volume: FatVolume = {
      image,
      clusterBytes,
      fat: await readBytes(image, partition + reservedSectors * sectorBytes, fatSectors * sectorBytes),
      dataOffset: partition + (reservedSectors + boot[16] * fatSectors) * sectorBytes,
    };
    const entries = directoryEntries(await clusterChain(volume, boot.readUInt32LE(44)));
    await mkdir(outputDirectory, { recursive: true });
    for (const [destination, names] of [
      ["kernel8.img", ["kernel8.img"]],
      ["initramfs8", ["initramfs8"]],
      ["board.dtb", ["bcm2710-rpi-zero-2-w.dtb"]],
    ] as const) {
      const entry = entries.find(candidate => names.some(name => name === candidate.name));
      if (!entry || entry.bytes > 128 * 1024 * 1024) {
        throw new Error(
          `Pinned image boot file missing/oversized: ${destination}; found ${entries.map(candidate => candidate.name).join(", ")}`
        );
      }
      const contents = (await clusterChain(volume, entry.cluster)).subarray(0, entry.bytes);
      await writeFile(join(outputDirectory, destination), contents);
      if (destination === "kernel8.img") {
        await writeFile(
          join(outputDirectory, "kernel8.raw"),
          await promisify(gunzip)(contents, { maxOutputLength: 128 * 1024 * 1024 })
        );
      }
    }
  } finally {
    await image.close();
  }
}

export async function createGuestDisk(imagePath: string, guestPath: string): Promise<void> {
  await copyFile(imagePath, guestPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const guest = await open(guestPath, "r+");
  try {
    const bytes = 8 * 1024 * 1024 * 1024;
    const partitionTable = await readBytes(guest, 0, 512);
    const rootSector = partitionTable.readUInt32LE(470);
    if (partitionTable[466] !== 0x83 || rootSector < 2048) {
      throw new Error("Unexpected pinned-image root partition");
    }
    await guest.truncate(bytes);
    partitionTable.writeUInt32LE(bytes / 512 - rootSector, 474);
    await guest.write(partitionTable, 0, 512, 0);
    await guest.sync();
  } finally {
    await guest.close();
  }
}

interface FatVolume {
  image: FileHandle;
  clusterBytes: number;
  dataOffset: number;
  fat: Buffer;
}
interface FatEntry {
  name: string;
  cluster: number;
  bytes: number;
}

async function readBytes(image: FileHandle, offset: number, bytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(bytes);
  let completed = 0;
  while (completed < bytes) {
    const result = await image.read(buffer, completed, bytes - completed, offset + completed);
    if (!result.bytesRead) {
      throw new Error("Unexpected end of Raspberry Pi OS image");
    }
    completed += result.bytesRead;
  }
  return buffer;
}

async function clusterChain(volume: FatVolume, firstCluster: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const visited = new Set<number>();
  let cluster = firstCluster;
  while (cluster < 0x0ffffff8) {
    if (
      cluster < 2 ||
      cluster * 4 + 4 > volume.fat.length ||
      visited.has(cluster) ||
      visited.size * volume.clusterBytes > 128 * 1024 * 1024
    ) {
      throw new Error("Invalid or oversized FAT cluster chain");
    }
    visited.add(cluster);
    chunks.push(
      await readBytes(volume.image, volume.dataOffset + (cluster - 2) * volume.clusterBytes, volume.clusterBytes)
    );
    cluster = volume.fat.readUInt32LE(cluster * 4) & 0x0fffffff;
  }
  return Buffer.concat(chunks);
}

function directoryEntries(directory: Buffer): FatEntry[] {
  const entries: FatEntry[] = [];
  let longName: string[] = [];
  for (let offset = 0; offset + 32 <= directory.length; offset += 32) {
    const entry = directory.subarray(offset, offset + 32);
    if (entry[0] === 0) {
      break;
    }
    if (entry[0] === 0xe5) {
      longName = [];
      continue;
    }
    if (entry[11] === 0x0f) {
      if (entry[0] & 0x40) {
        longName = [];
      }
      longName.unshift(
        Buffer.concat([entry.subarray(1, 11), entry.subarray(14, 26), entry.subarray(28, 32)]).toString("utf16le")
      );
      continue;
    }
    const extension = entry.subarray(8, 11).toString("ascii").trim();
    const shortName = entry.subarray(0, 8).toString("ascii").trim() + (extension ? `.${extension}` : "");
    const name = (longName.length ? longName.join("").split(/[\u0000\uffff]/)[0] : shortName).toLowerCase();
    longName = [];
    if (!(entry[11] & 0x18)) {
      entries.push({
        name,
        cluster: entry.readUInt16LE(20) * 65536 + entry.readUInt16LE(26),
        bytes: entry.readUInt32LE(28),
      });
    }
  }
  return entries;
}
