import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function pruneRuntimeDependencies(directory: string, lock: DependencyLock): Promise<void> {
  const installed = new Set(await installedPackages(directory));
  const required = new Set<string>();
  const pending = [""];
  while (pending.length > 0) {
    const packagePath = pending.pop()!;
    const entry = lock.packages[packagePath];
    if (!entry) {
      throw new Error(`Installed package is absent from the lockfile: ${packagePath}`);
    }
    const dependencies = { ...entry.dependencies, ...entry.optionalDependencies };
    for (const dependency of Object.keys(dependencies)) {
      if (isBuildOnlyDependency(dependency)) {
        continue;
      }
      const resolved = resolveDependency(packagePath, dependency, installed);
      if (!resolved) {
        if (entry.optionalDependencies?.[dependency]) {
          console.log(`Optional runtime dependency not installed: ${dependency}`);
          continue;
        }
        throw new Error(`${packagePath || "application"}: missing runtime dependency ${dependency}`);
      }
      if (!required.has(resolved)) {
        required.add(resolved);
        pending.push(resolved);
      }
    }
  }
  const removed = [...installed].filter(path => !required.has(path)).sort();
  for (const path of removed) {
    if ([...required].some(retained => retained.startsWith(path + "/"))) {
      throw new Error(`Runtime dependency is nested beneath excluded build tooling: ${path}`);
    }
  }
  const roots = removed.filter(path => !removed.some(parent => parent !== path && path.startsWith(parent + "/")));
  for (const path of roots) {
    await rm(join(directory, path), { recursive: true });
  }
  for (const parent of ["", ...required]) {
    const modulesDirectory = join(directory, parent, "node_modules");
    if (parent && !(await readdir(join(directory, parent))).includes("node_modules")) {
      continue;
    }
    const contents = await readdir(modulesDirectory);
    for (const generated of [".bin", ".package-lock.json"]) {
      if (contents.includes(generated)) {
        await rm(join(modulesDirectory, generated), { recursive: true });
      }
    }
  }
  console.log(`Kept ${required.size} runtime packages; removed ${removed.length} build/optional packages`);
}

export interface DependencyEntry {
  dev?: boolean;
  hasInstallScript?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface DependencyLock {
  packages: Record<string, DependencyEntry>;
}

export async function readDependencyLock(directory: string): Promise<DependencyLock> {
  return JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8")) as DependencyLock;
}

export async function assertNoDevDependencies(directory: string, lock: DependencyLock): Promise<void> {
  const installed = new Set(await installedPackages(directory));
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (entry.dev && installed.has(path)) {
      throw new Error(`Development dependency must not enter a bundle: ${path}`);
    }
  }
}

export async function assertNoBuildDependencies(directory: string): Promise<void> {
  for (const path of await installedPackages(directory)) {
    const pieces = path
      .split("/node_modules/")
      .at(-1)!
      .replace(/^node_modules\//, "");
    if (isBuildOnlyDependency(pieces)) {
      throw new Error(`Build-only dependency must not enter a bundle: ${path}`);
    }
  }
}

export async function preserveAddonLicenses(directory: string, runtimeDirectory: string): Promise<void> {
  const notices: string[] = [];
  for (const name of ["nan", "node-addon-api"]) {
    const packageDirectory = join(directory, "node_modules", name);
    const license = (await readdir(packageDirectory)).find(filename => /^licen[cs]e(?:\.md|\.txt)?$/i.test(filename));
    if (!license) {
      throw new Error(`Missing compiled-header license: ${name}`);
    }
    notices.push(`${name}\n${await readFile(join(packageDirectory, license), "utf8")}`);
  }
  await writeFile(join(runtimeDirectory, "addon-licenses.txt"), notices.join("\n\n"));
}

export function isBuildOnlyDependency(name: string): boolean {
  return (
    ["usocket", "node-gyp", "nan", "node-addon-api", "prebuild-install"].includes(name) || name.startsWith("@types/")
  );
}

async function installedPackages(directory: string, modulesPath = "node_modules"): Promise<string[]> {
  const packages: string[] = [];
  for (const entry of await readdir(join(directory, modulesPath), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (!entry.isDirectory()) {
      throw new Error(`Unexpected link or file in installed packages: ${modulesPath}/${entry.name}`);
    }
    const names = entry.name.startsWith("@")
      ? (await readdir(join(directory, modulesPath, entry.name))).map(name => `${entry.name}/${name}`)
      : [entry.name];
    for (const name of names) {
      const packagePath = join(modulesPath, name);
      packages.push(packagePath);
      if ((await readdir(join(directory, packagePath))).includes("node_modules")) {
        packages.push(...(await installedPackages(directory, join(packagePath, "node_modules"))));
      }
    }
  }
  return packages;
}

function resolveDependency(packagePath: string, name: string, installed: Set<string>): string | undefined {
  let directory = packagePath;
  for (;;) {
    const candidate = join(directory, "node_modules", name);
    if (installed.has(candidate)) {
      return candidate;
    }
    if (!directory) {
      return undefined;
    }
    const parent = dirname(directory);
    directory = parent === "." ? "" : parent;
  }
}
