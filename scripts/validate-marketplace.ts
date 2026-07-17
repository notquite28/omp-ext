/**
 * Validate marketplace catalog against on-disk plugin packages.
 * Run: bun scripts/validate-marketplace.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const catalogPath = join(root, ".claude-plugin/marketplace.json");

interface CatalogPlugin {
  name: string;
  version?: string;
  source: string | { source: string; repo?: string; path?: string };
  description?: string;
}

interface Catalog {
  name: string;
  owner: { name: string };
  metadata?: { description?: string; version?: string };
  plugins: CatalogPlugin[];
}

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`ok  ${msg}`);
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Catalog;

if (!catalog.name) fail("catalog missing name");
if (!catalog.owner?.name) fail("catalog missing owner.name");
if (!Array.isArray(catalog.plugins) || catalog.plugins.length === 0) {
  fail("catalog.plugins must be a non-empty array");
}
ok(`marketplace ${catalog.name} (${catalog.plugins.length} plugins)`);

const seen = new Set<string>();
let errors = 0;

for (const plugin of catalog.plugins) {
  const label = plugin.name || "<unnamed>";
  try {
    if (!plugin.name) throw new Error("missing name");
    if (seen.has(plugin.name)) throw new Error("duplicate plugin name");
    seen.add(plugin.name);

    if (typeof plugin.source !== "string" || !plugin.source.startsWith("./")) {
      throw new Error(`source must be relative path starting with ./ (got ${JSON.stringify(plugin.source)})`);
    }

    const srcDir = resolve(root, plugin.source);
    if (!srcDir.startsWith(root + "/") && srcDir !== root) {
      throw new Error(`source escapes repo root: ${plugin.source}`);
    }
    if (!existsSync(srcDir)) throw new Error(`source dir missing: ${plugin.source}`);

    const pkgPath = join(srcDir, "package.json");
    if (!existsSync(pkgPath)) throw new Error(`package.json missing under ${plugin.source}`);

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name?: string;
      version?: string;
      omp?: { extensions?: string[] };
      pi?: { extensions?: string[] };
    };

    if (pkg.name !== plugin.name) {
      throw new Error(`package name ${pkg.name} != catalog ${plugin.name}`);
    }
    if (!plugin.version) throw new Error("catalog entry missing version");
    if (pkg.version !== plugin.version) {
      throw new Error(`package version ${pkg.version} != catalog ${plugin.version}`);
    }

    const extensions = pkg.omp?.extensions ?? pkg.pi?.extensions ?? [];
    if (extensions.length === 0) {
      throw new Error("package has no omp.extensions / pi.extensions");
    }
    for (const entry of extensions) {
      const entryPath = resolve(srcDir, entry);
      if (!existsSync(entryPath)) {
        throw new Error(`extension entry missing: ${entry}`);
      }
    }

    ok(`${plugin.name}@${plugin.version} -> ${plugin.source} [${extensions.join(", ")}]`);
  } catch (err) {
    errors++;
    console.error(`FAIL ${label}: ${err instanceof Error ? err.message : err}`);
  }
}

// Known plugins expected in this marketplace
for (const required of ["omp-grok-build", "omp-rewind"]) {
  if (!seen.has(required)) {
    errors++;
    console.error(`FAIL: required plugin missing from catalog: ${required}`);
  }
}

if (errors > 0) {
  console.error(`\n${errors} error(s)`);
  process.exit(1);
}

console.log("\nmarketplace validation passed");
