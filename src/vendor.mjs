import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

// Copy a template file from templates/<file.from> into <target>/<file.to>.
// The destination lives in the consumer repo, so deleting this generator
// repo later does not affect already-vendored projects.
export async function vendorFile(target, file) {
  const src = join(TEMPLATES, file.from);
  const dest = join(target, file.to);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  console.log(`  + vendored ${file.to}`);
}
