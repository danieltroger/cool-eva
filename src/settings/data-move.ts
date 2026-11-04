import { lstat, readFile, readlink, realpath, rename, symlink } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { replaceFileDurably, syncDirectory } from "../storage/durable.ts";
import { assertSettingsWriterLock, type SettingsWriterLock } from "./writer-lock.ts";
import { record } from "./schema.ts";
import type { LegacyImport } from "./legacy.ts";
import type { SettingsPaths } from "./paths.ts";
import { flushArchivePermissions, normaliseArchivePermissions, validateArchiveTree } from "./data-permissions.ts";

export async function moveLegacyData(options: DataMoveOptions): Promise<LegacyImport["sourceDirectories"]> {
  assertSettingsWriterLock(options.lock);
  const journal = (await readJournal(options.paths)) ?? (await planMoves(options));
  if (journal.complete) return { ...journal.directories };
  // Validate every folder first: a refusal in the fourth must leave the first three in place too.
  for (const move of journal.moves) {
    const source = await optionalMetadata(move.source);
    await validateArchiveTree(source?.isDirectory() ? move.source : move.destination);
  }
  journal.permissionsSynced = false;
  await saveJournal(options.paths, journal);
  await checkpoint(options, "journal-saved");
  for (const move of journal.moves) {
    await resumeMove(move, options);
    await saveJournal(options.paths, journal);
  }
  await (options.flushPermissions ?? flushArchivePermissions)();
  journal.permissionsSynced = true;
  await saveJournal(options.paths, journal);
  await checkpoint(options, "permissions-synced");
  return { ...journal.directories };
}

export interface DataMoveOptions {
  paths: SettingsPaths;
  codeDirectory: string;
  legacyCaptureDirectory: string;
  sourceDirectories: LegacyImport["sourceDirectories"];
  archiveGroupId: number;
  lock: SettingsWriterLock;
  flushPermissions?: () => Promise<void>;
  destinationDevice?: (directory: string) => Promise<bigint>;
  /** Throws to replay a power cut at a persisted boundary, without touching real archives. */
  checkpoint?: (step: DataMoveCheckpoint) => Promise<void>;
}

export type DataMoveCheckpoint =
  | "journal-saved"
  | "renamed"
  | "parents-synced"
  | "permissions-applied"
  | "link-created"
  | "linked"
  | "permissions-synced"
  | "committed";

interface DataMove {
  source: string;
  destination: string;
  device: string;
  inode: string;
  state: "planned" | "linked";
}

interface MoveJournal {
  version: number;
  complete: boolean;
  permissionsSynced: boolean;
  moves: DataMove[];
  directories: LegacyImport["sourceDirectories"];
}

export class CrossFilesystemDataMoveError extends Error {
  constructor() {
    super(
      "Data migration crosses filesystems. Keep the old paths active and use an offline verified move; release cleanup is blocked."
    );
    this.name = "CrossFilesystemDataMoveError";
  }
}

export async function finishLegacyDataMove(options: DataMoveOptions): Promise<void> {
  assertSettingsWriterLock(options.lock);
  const journal = await readJournal(options.paths);
  if (journal === null || !journal.permissionsSynced || journal.moves.some(move => move.state !== "linked")) {
    throw new Error("The data move is not ready to commit.");
  }
  journal.complete = true;
  await saveJournal(options.paths, journal);
  await checkpoint(options, "committed");
}

export async function legacyDataMoveCompleted(paths: SettingsPaths, lock: SettingsWriterLock): Promise<boolean> {
  assertSettingsWriterLock(lock);
  return (await readJournal(paths))?.complete === true;
}

async function planMoves(options: DataMoveOptions): Promise<MoveJournal> {
  const directories = { ...options.sourceDirectories };
  const journal: MoveJournal = { version: 1, complete: false, permissionsSynced: false, moves: [], directories };
  const names = {
    rideLogDirectory: "ride-logs",
    vcuParameterDirectory: "vcu-params",
    wifiDiagnosticDirectory: "wifi-diag",
    captureDirectory: "captures",
  } as const;
  for (const key of Object.keys(names) as (keyof typeof names)[]) {
    let source = resolve(directories[key]);
    const oldDefault =
      key === "captureDirectory" ? options.legacyCaptureDirectory : join(options.codeDirectory, names[key]);
    const explicit = source !== oldDefault;
    if (explicit) {
      const retained = await retainedDirectory(source);
      const code = await realpath(options.codeDirectory);
      if (retained === code || retained.startsWith(`${code}/`)) {
        throw new Error(
          "An explicitly configured archive remains inside code. Choose an external directory in Settings → Advanced; release cleanup is blocked."
        );
      }
      directories[key] = retained;
      // Older history can remain in the unused default folder; release cleanup must not erase it.
      source = oldDefault;
    }
    const destination = options.paths[key];
    const metadata = await optionalMetadata(source);
    if (metadata?.isSymbolicLink()) {
      const target = await realpath(source);
      if (target === resolve(options.codeDirectory) || target.startsWith(`${resolve(options.codeDirectory)}/`)) {
        throw new Error("A legacy data link still points into the code directory; choose an external data location.");
      }
      if (!explicit) {
        directories[key] = target;
      }
      continue;
    }
    if (await optionalMetadata(destination)) {
      throw new Error("A data destination already exists without a matching move journal; no data was overwritten.");
    }
    if (metadata === null) {
      if (!explicit) {
        directories[key] = destination;
      }
      continue;
    }
    if (!metadata.isDirectory()) {
      throw new Error("A legacy data location is not a directory; no data was moved.");
    }
    const destinationDevice = options.destinationDevice
      ? await options.destinationDevice(dirname(destination))
      : (await lstat(dirname(destination), { bigint: true })).dev;
    if (metadata.dev !== destinationDevice) {
      throw new CrossFilesystemDataMoveError();
    }
    journal.moves.push({
      source,
      destination,
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
      state: "planned",
    });
    if (!explicit) {
      directories[key] = destination;
    }
  }
  return journal;
}

async function resumeMove(move: DataMove, options: DataMoveOptions): Promise<void> {
  let source = await optionalMetadata(move.source);
  let destination = await optionalMetadata(move.destination);
  if (source?.isSymbolicLink()) {
    if (
      resolve(dirname(move.source), await readlink(move.source)) !== move.destination ||
      !matchesMove(destination, move)
    ) {
      throw new Error("A legacy data link or destination changed; automatic migration is refused.");
    }
  } else {
    if (source !== null) {
      if (!matchesMove(source, move) || destination !== null) {
        throw new Error("A data-move source or destination conflicts with its journal.");
      }
      await rename(move.source, move.destination);
      await checkpoint(options, "renamed");
      destination = await optionalMetadata(move.destination);
      source = null;
    }
    if (!matchesMove(destination, move)) {
      throw new Error("The journalled data directory cannot be found; no replacement was created.");
    }
    await syncDirectory(dirname(move.source));
    await syncDirectory(dirname(move.destination));
    await checkpoint(options, "parents-synced");
  }
  await normaliseArchivePermissions(move.destination, options.archiveGroupId);
  await checkpoint(options, "permissions-applied");
  if (!source?.isSymbolicLink()) {
    await symlink(move.destination, move.source, "dir");
    await checkpoint(options, "link-created");
  }
  await syncDirectory(dirname(move.source));
  await checkpoint(options, "linked");
  move.state = "linked";
}

async function readJournal(paths: SettingsPaths): Promise<MoveJournal | null> {
  let contents: string;
  try {
    contents = await readFile(paths.moveJournal, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("settings: preparing the one-time data move");
      return null;
    }
    throw error;
  }
  try {
    const raw = record(JSON.parse(contents), "move journal");
    const directories = record(raw.directories, "move directories");
    if (raw.version !== 1 || typeof raw.complete !== "boolean" || !Array.isArray(raw.moves)) {
      throw new Error("invalid journal");
    }
    const moves: DataMove[] = raw.moves.map((value): DataMove => {
      const move = record(value, "move");
      for (const key of ["source", "destination", "device", "inode"] as const) {
        if (typeof move[key] !== "string") {
          throw new Error("invalid move");
        }
      }
      if (move.state !== "planned" && move.state !== "linked") {
        throw new Error("invalid move state");
      }
      return {
        source: String(move.source),
        destination: String(move.destination),
        device: String(move.device),
        inode: String(move.inode),
        state: move.state,
      };
    });
    for (const key of ["rideLogDirectory", "vcuParameterDirectory", "wifiDiagnosticDirectory", "captureDirectory"]) {
      if (typeof directories[key] !== "string") {
        throw new Error("invalid directories");
      }
    }
    return {
      version: 1,
      complete: raw.complete,
      permissionsSynced: raw.permissionsSynced === true,
      moves,
      directories: {
        rideLogDirectory: String(directories.rideLogDirectory),
        vcuParameterDirectory: String(directories.vcuParameterDirectory),
        wifiDiagnosticDirectory: String(directories.wifiDiagnosticDirectory),
        captureDirectory: String(directories.captureDirectory),
      },
    };
  } catch {
    throw new Error("The data-move journal is invalid. No data was changed; restore the journal before retrying.");
  }
}

async function saveJournal(paths: SettingsPaths, journal: MoveJournal): Promise<void> {
  await replaceFileDurably(paths.moveJournal, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
}

async function optionalMetadata(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function retainedDirectory(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn("settings: an explicit archive directory is absent; its configured path is retained");
      if (dirname(path) === path) {
        throw error;
      }
      return join(await retainedDirectory(dirname(path)), basename(path));
    }
    throw error;
  }
}

function matchesMove(metadata: Awaited<ReturnType<typeof optionalMetadata>>, move: DataMove): boolean {
  return (
    metadata !== null &&
    metadata.isDirectory() &&
    metadata.dev.toString() === move.device &&
    metadata.ino.toString() === move.inode
  );
}

async function checkpoint(options: DataMoveOptions, step: DataMoveCheckpoint): Promise<void> {
  await options.checkpoint?.(step);
}
