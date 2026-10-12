// Repository manifests are the single list of indexed networks for tools and tests.
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../..");
const MANIFEST = /^project-([a-z0-9-]+)\.yaml$/;

function manifestSlugs(root = REPO_ROOT) {
  return fs.readdirSync(root).map(file => MANIFEST.exec(file)?.[1]).filter(Boolean).sort();
}

// Returns the HTTP(S) form of the manifest endpoint; it is public configuration, not a secret.
function readManifest(slug, root = REPO_ROOT) {
  if (!manifestSlugs(root).includes(slug)) throw new Error(`Unknown manifest: project-${slug}.yaml`);
  const manifest = require("js-yaml").load(fs.readFileSync(path.join(root, `project-${slug}.yaml`), "utf8"));
  const endpoint = [manifest?.network?.endpoint].flat()[0];
  if (typeof endpoint !== "string" || !/^0x[\da-f]{64}$/i.test(manifest.network.chainId)) {
    throw new Error(`project-${slug}.yaml has no network endpoint or chainId`);
  }
  const file = manifest.network.chaintypes?.file;
  return { slug, manifest, chainId: manifest.network.chainId, endpoint: endpoint.trim().replace(/^ws/, "http"),
    bundle: file ? path.parse(file).name : null };
}

module.exports = { REPO_ROOT, manifestSlugs, readManifest };
